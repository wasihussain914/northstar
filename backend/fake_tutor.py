"""Stand-in for tutor.py when NORTHSTAR_FAKE_VISION=1.

Instead of asking Claude to read handwriting, it uses the text the dev helper
typed onto the board (sent as `transcript`). Everything downstream (SymPy, the
merge, hints UI, voice) runs for real, so the app can be tested without an API
key. Hints are templated, so they are much plainer than Claude's.
"""

from __future__ import annotations

import re

from tutor import TutorError

MODEL = "fake-vision"


def _problem_math(problem: str) -> str:
    text = re.sub(r"^\s*(solve|simplify|expand|factor)\s*:?\s*", "", problem, flags=re.I)
    return re.sub(r"\s+for\s+[a-z]\s*$", "", text, flags=re.I).strip()


def _kind(text: str) -> str:
    if any(op in text for op in ("<", ">", "≤", "≥")):
        return "inequality"
    return "equation" if "=" in text else "expression"


async def read_board(problem: str, transcript: dict[int, str] | None, lines: list[int]) -> dict:
    if not transcript:
        raise TutorError("Fake vision mode only reads lines written with northstar.write().")
    math = _problem_math(problem)
    letters = sorted(set(re.findall(r"[a-z]", math)))
    target = letters[0] if len(letters) == 1 and re.search(r"[=<>]", math) else ""
    out_lines = [{"line": n, "latex": transcript[n], "sympy": transcript[n], "kind": _kind(transcript[n]),
                  "ai_verdict": "unclear"} for n in sorted(transcript) if n in lines]
    return {
        "problem_sympy": math,
        "target_variable": target,
        "lines": out_lines,
        "next_step_hint": "What could you do to both sides to get the variable on its own?",
        "on_track_message": "Nice and steady.",
        "eta_steps": 2,
        "route_note": "",
    }


async def read_problem(image_png_b64: str) -> dict:
    # No vision here; hand back a known problem so the capture flow can be tested free.
    return {"problem": "Solve 2(x - 3) + 4 = 10", "latex": "2(x - 3) + 4 = 10"}


async def explain_line(problem: str, lines: list[dict], line: int, detail: str, note: str = "") -> dict:
    # `detail` can contain solution values; only the student-safe `note` is used.
    return {
        "hints": [
            f"Look closely at line {line}. Does it say the same thing as the line above it?",
            note or "Check each term as you carry it down.",
            f"Rewrite line {line} so it's equivalent to line {line - 1}.",
        ],
        "spoken_nudge": f"Recalculating. Take another look at line {line}.",
    }


async def ask(problem: str, question: str, image_png_b64: str | None, transcript: dict[int, str] | None,
              context: str) -> dict:
    return {"answer": f"(fake mode) You asked: {question}. Try comparing each line with the one above it."}
