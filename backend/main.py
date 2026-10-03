"""North Star API.

POST /api/check takes a snapshot of the board and returns, per line, whether
the student is still on route, plus hints for the first wrong turn.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).with_name(".env"))

import fake_tutor  # noqa: E402
import tts  # noqa: E402
import tutor  # noqa: E402  (needs the env loaded first)
import verify  # noqa: E402

SYMPY_TIMEOUT_S = 6.0
DEBUG_DIR = Path(__file__).with_name("debug") if os.environ.get("NORTHSTAR_DEBUG") else None
# Test without an API key: read the dev helper's typed text instead of the image.
FAKE_VISION = bool(os.environ.get("NORTHSTAR_FAKE_VISION"))


class SympyPool:
    """Runs SymPy in worker processes so a pathological expression can be killed."""

    def __init__(self) -> None:
        self._pool = ProcessPoolExecutor(max_workers=2)

    async def check(self, problem: str, steps: list[tuple[int, str]], target: str,
                    task: str = "") -> dict | None:
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(self._pool, verify.check_steps, problem, steps, target, task)
        try:
            return await asyncio.wait_for(future, SYMPY_TIMEOUT_S)
        except asyncio.TimeoutError:
            self._restart()
            return None

    def warm(self) -> None:
        for _ in range(2):
            self._pool.submit(verify.check_steps, "2x = 4", [(1, "x = 2")], "x")

    def _restart(self) -> None:
        old = self._pool
        self._pool = ProcessPoolExecutor(max_workers=2)
        for proc in list(getattr(old, "_processes", {}).values()):
            proc.terminate()
        old.shutdown(wait=False, cancel_futures=True)
        self.warm()

    def close(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)


sympy_pool: SympyPool | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global sympy_pool
    sympy_pool = SympyPool()
    sympy_pool.warm()
    yield
    sympy_pool.close()


app = FastAPI(title="North Star", lifespan=lifespan)


def cors_origins() -> list[str]:
    """Localhost is always allowed; a LAN IP is extra, for phones/tablets on Wi-Fi."""
    port = os.environ.get("FRONTEND_PORT", "5173").strip() or "5173"
    origins = [
        f"http://localhost:{port}",
        f"http://127.0.0.1:{port}",
    ]
    local_ip = os.environ.get("LOCAL_IP", "").strip()
    if local_ip:
        origins.append(f"http://{local_ip}:{port}")
    return origins


app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CheckRequest(BaseModel):
    problem: str = Field(default="", max_length=500)
    image: str = Field(description="PNG, base64 (a data: URL prefix is fine)", max_length=12_000_000)
    lines: list[int] = Field(default_factory=list, max_length=60)
    # Lines the student typed instead of writing (line -> exact text). Claude
    # uses them verbatim; fake-vision mode reads only these.
    transcript: dict[int, str] | None = Field(default=None, max_length=60)
    # Language for student-facing guidance (see tutor.LANGUAGES).
    lang: str = Field(default="en", max_length=8)


SKIP_KINDS = {"crossed_out", "not_math"}


def merge(board: dict, sym: dict | None) -> list[dict]:
    """Combine Claude's reading with SymPy's verdicts, line by line."""
    sym_results = (sym or {}).get("results", {})
    out = []
    for item in sorted(board.get("lines", []), key=lambda l: l["line"]):
        line, kind = item["line"], item["kind"]
        # `detail` is shown to the student; SymPy's internal detail (which can
        # contain solution values) stays server-side in `_detail`.
        entry = {"line": line, "latex": item["latex"], "sympy": item["sympy"], "kind": kind,
                 "status": "unclear", "source": "ai", "detail": "", "_detail": ""}
        if kind in SKIP_KINDS:
            entry["status"] = "skip"
        elif kind == "incomplete":
            entry["status"] = "pending"
        else:
            check = sym_results.get(line)
            if check and check["verdict"] != "unknown":
                entry["status"] = {"valid": "ok", "invalid": "error", "caution": "caution"}[check["verdict"]]
                entry["source"] = "verified"
                entry["detail"] = check.get("note", "")
                entry["_detail"] = check["detail"]
            else:
                entry["status"] = {"ok": "ok", "error": "error", "unclear": "unclear"}[item["ai_verdict"]]
        out.append(entry)
    return out


def decode_png(data: str) -> tuple[str, bytes]:
    """Accept a PNG as base64 or a data: URL; return (base64, raw bytes)."""
    b64 = data.split(",", 1)[1] if data.startswith("data:") else data
    try:
        raw = base64.b64decode(b64, validate=True)
    except ValueError:
        raise HTTPException(400, "image is not valid base64")
    if not raw.startswith(b"\x89PNG"):
        raise HTTPException(400, "image must be a PNG")
    return b64, raw


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "has_key": FAKE_VISION or tutor.has_api_key(),
            "model": fake_tutor.MODEL if FAKE_VISION else tutor.active_model(),
            "provider": "fake" if FAKE_VISION else (
                "grok" if tutor.using_grok() else "gemini" if tutor.using_gemini() else "claude"),
            "tts": tts.enabled(),
            "fake": FAKE_VISION}


@app.post("/api/check")
async def check(req: CheckRequest) -> dict:
    image, raw = decode_png(req.image)

    stamp = time.strftime("%H%M%S")
    if DEBUG_DIR:
        DEBUG_DIR.mkdir(exist_ok=True)
        (DEBUG_DIR / f"{stamp}.png").write_bytes(raw)

    def line_steps(b: dict) -> list[tuple[int, str]]:
        return [(l["line"], l["sympy"]) for l in sorted(b["lines"], key=lambda l: l["line"])
                if l["kind"] not in SKIP_KINDS and l["kind"] != "incomplete"]

    started = time.perf_counter()
    board = sym = None

    # Fast path: every line was typed, so the text is exact and a model read
    # adds nothing. SymPy alone turns a check into milliseconds; if it can't
    # decide a single line, fall through to the full model read below.
    if not FAKE_VISION and req.transcript and req.lines and all(n in req.transcript for n in req.lines):
        candidate = fake_tutor.transcript_board(req.problem, req.transcript, req.lines)
        verdict_check = await sympy_pool.check(candidate.get("problem_sympy", ""), line_steps(candidate),
                                               candidate.get("target_variable", ""), candidate.get("task") or "")
        if verdict_check and any(r["verdict"] != "unknown" for r in verdict_check["results"].values()):
            board, sym = candidate, verdict_check

    if board is None:
        try:
            if FAKE_VISION:
                board = await fake_tutor.read_board(req.problem, req.transcript, req.lines, req.lang)
            else:
                board = await tutor.read_board(req.problem, image, req.lines, req.transcript, req.lang)
        except tutor.TutorError as exc:
            raise HTTPException(502, str(exc))
        sym = await sympy_pool.check(board.get("problem_sympy", ""), line_steps(board),
                                     board.get("target_variable", ""), board.get("task") or "")
    read_ms = (time.perf_counter() - started) * 1000

    lines = merge(board, sym)

    first_error = next((l["line"] for l in lines if l["status"] == "error"), None)
    hints, hint_ink, spoken = [], [], ""
    if first_error is not None:
        # Hints are a second, text-only call, made only when there is a wrong
        # turn — the common no-error check pays for transcription alone.
        flagged = next(l for l in lines if l["line"] == first_error)
        try:
            explained = await (fake_tutor if FAKE_VISION else tutor).explain_line(
                req.problem, lines, first_error, flagged["_detail"], flagged["detail"], req.lang)
            hints, spoken = explained["hints"], explained["spoken_nudge"]
            hint_ink = explained.get("hint_ink", [])
        except tutor.TutorError:
            hints = [f"Take another look at line {first_error}. Does it really follow from the line above?",
                     flagged["detail"] or "Compare it carefully with the previous line.", ""]
            spoken = f"Recalculating. Take another look at line {first_error}."
            hint_ink = ["compare with above", "check each term", ""]

    has_work = any(l["status"] not in ("skip", "pending") for l in lines)
    arrived = first_error is None and has_work and (
        bool(sym and sym.get("arrived")) or (not board.get("target_variable") and board.get("eta_steps", 1) == 0))

    result = {
        "lines": [{k: v for k, v in l.items() if not k.startswith("_")} for l in lines],
        "first_error": first_error,
        "hints": [h for h in hints if h][:3],
        "hint_ink": [h for h in hint_ink if h][:3],
        "spoken_nudge": spoken,
        "next_step_hint": "" if first_error or arrived else board.get("next_step_hint", ""),
        "next_step_ink": "" if first_error or arrived else board.get("next_step_ink", ""),
        "on_track_message": board.get("on_track_message", ""),
        "eta_steps": 0 if arrived else max(0, int(board.get("eta_steps", 0))),
        "route_note": board.get("route_note", ""),
        "arrived": arrived,
        "verified": sym is not None,
        "timing_ms": {"read": round(read_ms), "total": round((time.perf_counter() - started) * 1000)},
    }

    if DEBUG_DIR:
        (DEBUG_DIR / f"{stamp}.json").write_text(json.dumps({"board": board, "sympy": sym, "result": result},
                                                            indent=2, default=str))
    return result


class ProblemRequest(BaseModel):
    image: str = Field(description="PNG, base64 (a data: URL prefix is fine)", max_length=12_000_000)


@app.post("/api/problem")
async def problem(req: ProblemRequest) -> dict:
    """Read the problem(s) off a cropped photo of the student's homework."""
    image, _ = decode_png(req.image)
    try:
        out = await (fake_tutor if FAKE_VISION else tutor).read_problem(image)
    except tutor.TutorError as exc:
        raise HTTPException(502, str(exc))
    problems = [{"problem": p["problem"], "latex": p.get("latex", "")}
                for p in out.get("problems", []) if p.get("problem")]
    if not problems:
        raise HTTPException(422, "Couldn't find a math problem in that crop. Try a tighter one.")
    return {"problems": problems}


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    lang: str = Field(default="en", max_length=8)


@app.post("/api/speak")
async def speak(req: SpeakRequest) -> Response:
    """The GPS voice as neural audio. 503 when no TTS key: use browser speech."""
    if not tts.enabled():
        raise HTTPException(503, "No XAI_API_KEY or ELEVENLABS_API_KEY on the server; use browser speech.")
    try:
        audio = await tts.speak(req.text, req.lang)
    except Exception as exc:
        raise HTTPException(502, f"Text-to-speech failed: {exc}")
    return Response(content=audio, media_type="audio/mpeg")


class PlanRequest(BaseModel):
    problem: str = Field(default="", max_length=500)
    plan: str = Field(min_length=1, max_length=1000)
    lang: str = Field(default="en", max_length=8)


@app.post("/api/plan")
async def plan(req: PlanRequest) -> dict:
    """Route preview: the student says how they'd solve it; the navigator judges the route."""
    try:
        out = await (fake_tutor if FAKE_VISION else tutor).check_plan(req.problem, req.plan, req.lang)
    except tutor.TutorError as exc:
        raise HTTPException(502, str(exc))
    return {"verdict": out.get("verdict", "partial"), "feedback": out.get("feedback", ""),
            "spoken": out.get("spoken", out.get("feedback", ""))}


class PracticeRequest(BaseModel):
    problem: str = Field(default="", max_length=500)
    wrong_line: str = Field(default="", max_length=300)
    note: str = Field(default="", max_length=500)
    lang: str = Field(default="en", max_length=8)


@app.post("/api/practice")
async def practice(req: PracticeRequest) -> dict:
    """A detour: one fresh problem exercising the skill the student just got wrong."""
    try:
        out = await (fake_tutor if FAKE_VISION else tutor).practice_problem(
            req.problem, req.wrong_line, req.note, req.lang)
    except tutor.TutorError as exc:
        raise HTTPException(502, str(exc))
    if not out.get("problem"):
        raise HTTPException(422, "Couldn't chart a detour for that one.")
    return {"problem": out["problem"], "latex": out.get("latex", ""), "skill": out.get("skill", "")}


class AskRequest(BaseModel):
    problem: str = Field(default="", max_length=500)
    question: str = Field(min_length=1, max_length=500)
    image: str | None = Field(default=None, max_length=12_000_000)
    context: str = Field(default="", max_length=4000)
    transcript: dict[int, str] | None = None
    lang: str = Field(default="en", max_length=8)


@app.post("/api/ask")
async def ask(req: AskRequest) -> dict:
    image = decode_png(req.image)[0] if req.image else None
    try:
        return await (fake_tutor if FAKE_VISION else tutor).ask(req.problem, req.question, image, req.transcript,
                                                                req.context, req.lang)
    except tutor.TutorError as exc:
        raise HTTPException(502, str(exc))


# Serve the built frontend (frontend/dist) when it exists, so one process can
# host the whole app for deploys. API routes above take precedence.
_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="app")
