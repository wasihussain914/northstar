"""Untangled API.

POST /api/check takes a snapshot of the board and returns, per line, whether
the student is still on route, plus hints for the first wrong turn.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import struct
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


app = FastAPI(title="Untangled", lifespan=lifespan)


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
    # Lines whose written-on-the-board question was already answered, so a
    # question isn't re-answered on every subsequent check while it stays inked.
    answered: list[int] = Field(default_factory=list, max_length=60)
    # Lines the client already had read on an earlier check and hasn't touched
    # since: the model reads only what's new (the image is cropped to it).
    known: dict[int, "KnownLine"] | None = Field(default=None, max_length=60)
    # The problem as the model last parsed it, so a check with nothing new to
    # read (an erased line, say) can skip the model entirely.
    known_problem: "KnownProblem | None" = None


class KnownLine(BaseModel):
    latex: str = Field(default="", max_length=2000)
    sympy: str = Field(default="", max_length=2000)
    kind: str = Field(default="expression", max_length=20)
    ai_verdict: str = Field(default="unclear", max_length=10)


class KnownProblem(BaseModel):
    problem_sympy: str = Field(default="", max_length=2000)
    target_variable: str = Field(default="", max_length=20)
    task: str = Field(default="", max_length=20)


class HintsRequest(BaseModel):
    """Hints for the first wrong turn: a separate call so the check itself
    doesn't wait on it (the GPS says "recalculating" at once, the detail follows)."""
    problem: str = Field(default="", max_length=500)
    lines: list[KnownLine | dict] = Field(default_factory=list, max_length=60)
    line_numbers: list[int] = Field(default_factory=list, max_length=60)
    first_error: int
    known_problem: KnownProblem | None = None
    lang: str = Field(default="en", max_length=8)


# Questions are answered, not judged; reference formulas and independent
# intermediate work are judged in context by the AI rather than compared
# for equivalence with adjacent steps by SymPy.
SKIP_KINDS = {"crossed_out", "not_math", "question", "formula", "intermediate"}



def step_lines(board: dict) -> list[tuple[int, str]]:
    """Lines SymPy should chain-check. Reference formulas and intermediate
    work only join in calculus tasks, where the domain checker judges each
    line on its own merits (substitutions, differentials) instead of
    comparing neighbours."""
    from domains import resolve_task
    calc = resolve_task(board.get("problem_sympy", ""), board.get("task", "")) in (
        "integrate", "differentiate", "ode", "pde", "limit")
    out = []
    for l in sorted(board.get("lines", []), key=lambda l: l["line"]):
        kind = l["kind"]
        if kind in ("crossed_out", "not_math", "question", "incomplete"):
            continue
        if kind in ("formula", "intermediate") and not calc:
            continue
        out.append((l["line"], l["sympy"]))
    return out


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
        if kind in {"formula", "intermediate"}:
            # SymPy can prove substitutions ("u = x^2", "du = 2x dx"): a proven
            # line shows verified. Otherwise only an actual math error is a
            # wrong turn, never a change of context.
            check = sym_results.get(line)
            if check and check["verdict"] == "valid":
                entry["status"], entry["source"] = "ok", "verified"
            elif check and check["verdict"] == "invalid" and check.get("note"):
                entry["status"], entry["source"] = "error", "verified"
                entry["detail"], entry["_detail"] = check.get("note", ""), check["detail"]
            else:
                entry["status"] = "error" if item["ai_verdict"] == "error" else "skip"
        elif kind in SKIP_KINDS:
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


def _blank_page_png(width: int = 480, height: int = 240) -> str:
    """A plain white page, base64. Cached after the first build."""
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + b"\xff" * (3 * width) for _ in range(height))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    return base64.b64encode(png).decode()


_BLANK_PAGE: str | None = None


def readable_png(b64: str, raw: bytes) -> str:
    """The image, unless it's a placeholder too small for a vision model.

    Typed boards upload a 1x1 image to save bandwidth; when a check still
    needs the model (e.g. proof claims SymPy can't judge), Grok rejects a
    1-pixel image, so substitute a blank page — the typed transcript carries
    the content.
    """
    global _BLANK_PAGE
    try:
        width, height = struct.unpack(">II", raw[16:24])
    except struct.error:
        return b64
    if width >= 16 and height >= 16:
        return b64
    if _BLANK_PAGE is None:
        _BLANK_PAGE = _blank_page_png()
    return _BLANK_PAGE


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "has_key": FAKE_VISION or tutor.has_api_key(),
            "model": fake_tutor.MODEL if FAKE_VISION else tutor.active_model(),
            "provider": "fake" if FAKE_VISION else (
                "grok" if tutor.using_grok() else "gemini" if tutor.using_gemini() else "claude"),
            "tts": tts.enabled(),
            "stt": bool(WHISPER_CMD),
            "fake": FAKE_VISION}


# Server-side speech-to-text: iPad Safari's SpeechRecognition hangs the page,
# so the client records audio and we transcribe it here. NORTHSTAR_WHISPER is
# a command (e.g. "/path/venv/bin/python /path/transcribe.py"); the audio file
# path is appended. Transcript comes back on stdout.
WHISPER_CMD = os.environ.get("NORTHSTAR_WHISPER", "").strip()

_AUDIO_EXT = {"audio/webm": ".webm", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a",
              "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/ogg": ".ogg"}


class TranscribeRequest(BaseModel):
    audio: str = Field(description="base64 audio (a data: URL prefix is fine)", max_length=15_000_000)
    mime: str = Field(default="audio/webm", max_length=80)


@app.post("/api/transcribe")
async def transcribe(req: TranscribeRequest) -> dict:
    if not WHISPER_CMD:
        raise HTTPException(503, "no transcriber configured on this server")
    b64 = req.audio.split(",", 1)[1] if req.audio.startswith("data:") else req.audio
    try:
        raw = base64.b64decode(b64, validate=True)
    except ValueError:
        raise HTTPException(400, "audio is not valid base64")
    if not raw:
        raise HTTPException(400, "empty audio")
    import shlex
    import tempfile
    ext = _AUDIO_EXT.get(req.mime.split(";")[0].strip().lower(), ".webm")
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as f:
        f.write(raw)
        path = f.name
    try:
        proc = await asyncio.create_subprocess_exec(
            *shlex.split(WHISPER_CMD), path,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), 30)
        except asyncio.TimeoutError:
            proc.kill()
            raise HTTPException(504, "transcription timed out")
        if proc.returncode != 0:
            raise HTTPException(502, "transcription failed")
        return {"text": out.decode("utf-8", "replace").strip()}
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


@app.post("/api/check")
async def check(req: CheckRequest) -> dict:
    image, raw = decode_png(req.image)

    stamp = time.strftime("%H%M%S")
    if DEBUG_DIR:
        DEBUG_DIR.mkdir(exist_ok=True)
        (DEBUG_DIR / f"{stamp}.png").write_bytes(raw)

    def line_steps(b: dict) -> list[tuple[int, str]]:
        return step_lines(b)

    started = time.perf_counter()
    board = sym = None
    known = {n: k for n, k in (req.known or {}).items() if n in req.lines}
    typed = {n: t for n, t in (req.transcript or {}).items() if n in req.lines}
    # Lines nobody has read yet: not typed, not read on an earlier check.
    unread = [n for n in req.lines if n not in typed and n not in known]
    model_read = False

    # Fast path: every line is already text (typed, or read on an earlier
    # check), so a model read adds nothing. SymPy alone turns a check into
    # milliseconds; if it can't decide a single line, fall through to the
    # full model read below.
    if not FAKE_VISION and req.lines and not unread:
        candidate = fake_tutor.transcript_board(req.problem, typed, req.lines)
        for n, k in known.items():
            if n in typed:
                continue
            candidate["lines"].append({"line": n, "latex": k.latex, "sympy": k.sympy, "kind": k.kind,
                                       "ai_verdict": k.ai_verdict})
        candidate["lines"].sort(key=lambda l: l["line"])
        if req.known_problem and req.known_problem.problem_sympy:
            candidate["problem_sympy"] = req.known_problem.problem_sympy
            candidate["target_variable"] = req.known_problem.target_variable
            candidate["task"] = req.known_problem.task
        verdict_check = await sympy_pool.check(candidate.get("problem_sympy", ""), line_steps(candidate),
                                               candidate.get("target_variable", ""), candidate.get("task") or "")
        if (verdict_check and verdict_check["results"]
                and all(r["verdict"] == "valid" for r in verdict_check["results"].values())):
            board, sym = candidate, verdict_check
            # SymPy has no guidance to offer; the client keeps showing the last read's.
            board["next_step_hint"] = board["next_step_ink"] = board["on_track_message"] = ""
            board["eta_steps"] = -1

    if board is None:
        try:
            if FAKE_VISION:
                merged = {**{n: k.sympy for n, k in known.items()}, **typed}
                board = await fake_tutor.read_board(req.problem, merged, req.lines, req.lang)
            else:
                board = await tutor.read_board(req.problem, readable_png(image, raw), req.lines, typed,
                                               req.lang, known={n: k.model_dump() for n, k in known.items()})
                model_read = True
                # Splice in what the model was told not to re-read.
                got = {l["line"] for l in board.get("lines", [])}
                for n, k in known.items():
                    if n not in got:
                        board.setdefault("lines", []).append({"line": n, "latex": k.latex, "sympy": k.sympy,
                                                              "kind": k.kind, "ai_verdict": k.ai_verdict})
        except tutor.TutorError as exc:
            raise HTTPException(502, str(exc))
        sym = await sympy_pool.check(board.get("problem_sympy", ""), line_steps(board),
                                     board.get("target_variable", ""), board.get("task") or "")
    read_ms = (time.perf_counter() - started) * 1000

    lines = merge(board, sym)

    first_error = next((l["line"] for l in lines if l["status"] == "error"), None)
    # Hints (and fix_line) are fetched by the client in a separate call
    # (POST /api/hints), so the check — and the "recalculating" voice —
    # never wait on them.
    hints, hint_ink, spoken, fix_line = [], [], "", ""

    # A question written on the board ("what do i do?") gets answered out
    # loud, once: the client lists lines it already heard answers for.
    board_question = None
    asked = next((l for l in lines if l["kind"] == "question" and l["latex"].strip()
                  and l["line"] not in req.answered), None)
    if asked is not None:
        context = "; ".join(f"line {l['line']} ({l['status']}): {l['latex']}"
                            for l in lines if l["kind"] != "question" and l["latex"])
        try:
            answer = await (fake_tutor if FAKE_VISION else tutor).ask(
                req.problem, asked["latex"], None, req.transcript, context, req.lang, want_ink=True)
            board_question = {"line": asked["line"], "question": asked["latex"],
                              "answer": answer["answer"], "ink": answer.get("ink", "")}
        except tutor.TutorError:
            board_question = None

    has_work = any(l["status"] not in ("skip", "pending") for l in lines)
    sym_results = (sym or {}).get("results", {})
    ai_arrived = any(
        item.get("final_answer") is True and item.get("ai_verdict") == "ok"
        and item["kind"] not in SKIP_KINDS and item["kind"] != "incomplete"
        and sym_results.get(item["line"], {}).get("verdict", "unknown") == "unknown"
        for item in board.get("lines", [])
    )
    arrived = first_error is None and has_work and (
        bool(sym and sym.get("arrived")) or ai_arrived)

    result = {
        "lines": [{k: v for k, v in l.items() if not k.startswith("_")} for l in lines],
        "first_error": first_error,
        "hints": [h for h in hints if h][:3],
        "hint_ink": [h for h in hint_ink if h][:3],
        "fix_line": fix_line or "",
        "spoken_nudge": spoken,
        "next_step_hint": "" if first_error or arrived else board.get("next_step_hint", ""),
        "next_step_ink": "" if first_error or arrived else board.get("next_step_ink", ""),
        "on_track_message": board.get("on_track_message", ""),
        # -1: no fresh estimate this round (nothing was read); keep the last
        # one. A fresh read that hasn't arrived is always at least 1 step out.
        "eta_steps": (0 if arrived
                      else max(1, int(board.get("eta_steps", 1))) if model_read or FAKE_VISION
                      else -1),
        "route_note": board.get("route_note", ""),
        "arrived": arrived,
        "verified": sym is not None,
        "board_question": board_question,
        # What the client should echo next time so these lines aren't re-read.
        "known": {l["line"]: {"latex": l["latex"], "sympy": l["sympy"], "kind": l["kind"],
                              "ai_verdict": l["status"] if l["source"] == "ai" and l["status"] in ("ok", "error", "unclear")
                              else "ok"}
                  for l in lines if l["status"] != "pending"},
        "known_problem": {"problem_sympy": board.get("problem_sympy", ""),
                          "target_variable": board.get("target_variable", ""),
                          "task": board.get("task") or ""},
        "timing_ms": {"read": round(read_ms), "total": round((time.perf_counter() - started) * 1000),
                      "model_read": model_read, "lines_read": len(unread)},
    }

    if DEBUG_DIR:
        (DEBUG_DIR / f"{stamp}.json").write_text(json.dumps({"board": board, "sympy": sym, "result": result},
                                                            indent=2, default=str))
    return result


@app.post("/api/hints")
async def hints(req: HintsRequest) -> dict:
    """The hint ladder for the first wrong turn. SymPy is re-run here (it's
    milliseconds) so its internal detail never has to leave the server."""
    board = {"problem_sympy": "", "target_variable": "", "task": "", "lines": []}
    if req.known_problem:
        board.update(req.known_problem.model_dump())
    for i, raw in enumerate(req.lines):
        k = raw if isinstance(raw, KnownLine) else KnownLine(**{key: raw.get(key, "") for key in ("latex", "sympy", "kind", "ai_verdict") if key in raw})
        n = req.line_numbers[i] if i < len(req.line_numbers) else i + 1
        board["lines"].append({"line": n, "latex": k.latex, "sympy": k.sympy, "kind": k.kind,
                               "ai_verdict": k.ai_verdict})
    steps = step_lines(board)
    sym = await sympy_pool.check(board["problem_sympy"], steps, board["target_variable"], board["task"])
    lines = merge(board, sym)
    flagged = next((l for l in lines if l["line"] == req.first_error), None)
    if flagged is None:
        raise HTTPException(400, "first_error is not one of the lines")
    try:
        explained = await (fake_tutor if FAKE_VISION else tutor).explain_line(
            req.problem, lines, req.first_error, flagged["_detail"], flagged["detail"], req.lang)
        hints, spoken = explained["hints"], explained["spoken_nudge"]
        hint_ink = explained.get("hint_ink", [])
        fix_line = explained.get("fix_line", "")
    except tutor.TutorError:
        hints = [f"Take another look at line {req.first_error}. Does it really follow from the line above?",
                 flagged["detail"] or "Compare it carefully with the previous line.", ""]
        spoken = f"Recalculating. Take another look at line {req.first_error}."
        hint_ink = ["compare with above", "check each term", ""]
        fix_line = ""
    return {"hints": [h for h in hints if h][:3], "hint_ink": [h for h in hint_ink if h][:3],
            "fix_line": fix_line or "", "spoken_nudge": spoken}


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


class FinishRequest(BaseModel):
    problem: str = Field(default="", max_length=500)
    # The work so far, as text (typed text or the latex as read), in board order.
    lines: list[dict] = Field(default_factory=list, max_length=60)
    lang: str = Field(default="en", max_length=8)


# The stage-demo problem gets a fixed, SymPy-verified solution: the live demo
# must write the same clean by-parts work every single time.
DEMO_FINISH = {
    "integratex^2e^xdx": [
        "u = x^2",
        "du = 2x dx",
        "dv = e^x dx",
        "v = e^x",
        "int x^2 e^x dx = x^2 e^x - int 2x e^x dx",
        "x^2 e^x - 2(x e^x - e^x) + C",
        "x^2 e^x - 2x e^x + 2 e^x + C",
    ],
}


def canned_finish(problem: str, existing: list[dict]) -> list[str] | None:
    key = "".join((problem or "").lower().split()).replace("*", "").replace("exp(x)", "e^x")
    key = key.replace("integrate(", "integrate").replace(",x)", "dx")
    steps = DEMO_FINISH.get(key)
    if not steps:
        return None
    written = {"".join(str(l.get("text", "")).lower().split()) for l in existing}
    remaining = [s for s in steps if "".join(s.lower().split()) not in written]
    return remaining or None


@app.post("/api/finish")
async def finish(req: FinishRequest) -> dict:
    """Write the rest of the solution, one line per step, from the student's last line."""
    lines = [{"line": int(l.get("line", i + 1)), "text": str(l.get("text", ""))[:500]}
             for i, l in enumerate(req.lines)]
    canned = canned_finish(req.problem, lines)
    if canned is not None:
        return {"steps": canned[:8]}
    try:
        out = await (fake_tutor if FAKE_VISION else tutor).finish_work(req.problem, lines, req.lang)
    except tutor.TutorError as exc:
        raise HTTPException(502, str(exc))
    steps = [str(s).strip() for s in out.get("steps", []) if str(s).strip()][:8]
    if not steps:
        raise HTTPException(422, "Couldn't work out the rest of that one.")
    return {"steps": steps}


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


_SAMPLES_PATH = Path(__file__).with_name("data") / "basic.json"


@app.get("/api/samples")
async def get_samples():
    """Return the handwriting glyph dataset as JSON."""
    from fastapi.responses import FileResponse
    if not _SAMPLES_PATH.exists():
        raise HTTPException(404, "basic.json not found")
    return FileResponse(_SAMPLES_PATH, media_type="application/json")

# Serve the built frontend (frontend/dist) when it exists, so one process can
# host the whole app for deploys. API routes above take precedence.
_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="app")
