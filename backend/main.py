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
from pydantic import BaseModel, Field

load_dotenv(Path(__file__).with_name(".env"))

import fake_tutor  # noqa: E402
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

    async def check(self, problem: str, steps: list[tuple[int, str]], target: str) -> dict | None:
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(self._pool, verify.check_steps, problem, steps, target)
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


class CheckRequest(BaseModel):
    problem: str = Field(default="", max_length=500)
    image: str = Field(description="PNG, base64 (a data: URL prefix is fine)", max_length=12_000_000)
    lines: list[int] = Field(default_factory=list, max_length=60)
    # Lines the student typed instead of writing (line -> exact text). Claude
    # uses them verbatim; fake-vision mode reads only these.
    transcript: dict[int, str] | None = Field(default=None, max_length=60)


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
    return {"ok": True, "has_key": FAKE_VISION or bool(os.environ.get("ANTHROPIC_API_KEY")),
            "model": fake_tutor.MODEL if FAKE_VISION else tutor.MODEL, "fake": FAKE_VISION}


@app.post("/api/check")
async def check(req: CheckRequest) -> dict:
    image, raw = decode_png(req.image)

    stamp = time.strftime("%H%M%S")
    if DEBUG_DIR:
        DEBUG_DIR.mkdir(exist_ok=True)
        (DEBUG_DIR / f"{stamp}.png").write_bytes(raw)

    started = time.perf_counter()
    try:
        if FAKE_VISION:
            board = await fake_tutor.read_board(req.problem, req.transcript, req.lines)
        else:
            board = await tutor.read_board(req.problem, image, req.lines, req.transcript)
    except tutor.TutorError as exc:
        raise HTTPException(502, str(exc))
    read_ms = (time.perf_counter() - started) * 1000

    steps = [(l["line"], l["sympy"]) for l in sorted(board["lines"], key=lambda l: l["line"])
             if l["kind"] not in SKIP_KINDS and l["kind"] != "incomplete"]
    sym = await sympy_pool.check(board.get("problem_sympy", ""), steps, board.get("target_variable", ""))
    lines = merge(board, sym)

    first_error = next((l["line"] for l in lines if l["status"] == "error"), None)
    hints, spoken = [], ""
    if first_error is not None:
        # Hints are a second, text-only call, made only when there is a wrong
        # turn — the common no-error check pays for transcription alone.
        flagged = next(l for l in lines if l["line"] == first_error)
        try:
            explained = await (fake_tutor if FAKE_VISION else tutor).explain_line(
                req.problem, lines, first_error, flagged["_detail"], flagged["detail"])
            hints, spoken = explained["hints"], explained["spoken_nudge"]
        except tutor.TutorError:
            hints = [f"Take another look at line {first_error}. Does it really follow from the line above?",
                     flagged["detail"] or "Compare it carefully with the previous line.", ""]
            spoken = f"Recalculating. Take another look at line {first_error}."

    has_work = any(l["status"] not in ("skip", "pending") for l in lines)
    arrived = first_error is None and has_work and (
        bool(sym and sym.get("arrived")) or (not board.get("target_variable") and board.get("eta_steps", 1) == 0))

    result = {
        "lines": [{k: v for k, v in l.items() if not k.startswith("_")} for l in lines],
        "first_error": first_error,
        "hints": [h for h in hints if h][:3],
        "spoken_nudge": spoken,
        "next_step_hint": "" if first_error or arrived else board.get("next_step_hint", ""),
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


class AskRequest(BaseModel):
    problem: str = Field(default="", max_length=500)
    question: str = Field(min_length=1, max_length=500)
    image: str | None = Field(default=None, max_length=12_000_000)
    context: str = Field(default="", max_length=4000)
    transcript: dict[int, str] | None = None


@app.post("/api/ask")
async def ask(req: AskRequest) -> dict:
    image = decode_png(req.image)[0] if req.image else None
    try:
        return await (fake_tutor if FAKE_VISION else tutor).ask(req.problem, req.question, image, req.transcript,
                                                                req.context)
    except tutor.TutorError as exc:
        raise HTTPException(502, str(exc))
