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
    # "Differentiate <f>" becomes the dialect diff(<f>, x) so the real domain
    # checkers run even in fake mode (the demo script relies on this).
    text = problem.strip()
    lower = text.lower()

    body = ""
    for prefix in ("differentiate", "derivative of"):
        if lower.startswith(prefix):
            body = text[len(prefix):].lstrip()
            if body.startswith(":"):
                body = body[1:].lstrip()
            break
    if body:
        letters = sorted(set(re.findall(r"[a-z]", body))) or ["x"]
        return f"diff({body}, {letters[0]})"

    for prefix in ("solve", "simplify", "expand", "factor"):
        if lower.startswith(prefix):
            text = text[len(prefix):].lstrip()
            if text.startswith(":"):
                text = text[1:].lstrip()
            break

    parts = text.rsplit(" for ", 1)
    if len(parts) == 2 and len(parts[1].strip()) == 1 and parts[1].strip().isalpha():
        text = parts[0]
    return text.strip()


def _kind(text: str) -> str:
    if any(op in text for op in ("<", ">", "≤", "≥")):
        return "inequality"
    return "equation" if "=" in text else "expression"


def transcript_board(problem: str, transcript: dict[int, str], lines: list[int]) -> dict:
    """A board built from typed text alone — no vision call needed.

    Used by fake mode, and by the production fast path when every line on the
    board was typed (the text is exact, so a model read adds nothing).
    """
    math = _problem_math(problem)
    letters = sorted(set(re.findall(r"[a-z]", math)))
    target = letters[0] if len(letters) == 1 and re.search(r"[=<>]", math) else ""
    out_lines = [{"line": n, "latex": transcript[n], "sympy": transcript[n], "kind": _kind(transcript[n]),
                  "ai_verdict": "unclear"} for n in sorted(transcript) if n in lines]
    return {
        "problem_sympy": math,
        "target_variable": target,
        "task": "",
        "lines": out_lines,
        "next_step_hint": "What could you do to both sides to get the variable on its own?",
        "next_step_ink": "isolate the variable",
        "on_track_message": "Nice and steady.",
        "eta_steps": 2,
        "route_note": "",
    }


async def read_board(problem: str, transcript: dict[int, str] | None, lines: list[int],
                     lang: str = "en") -> dict:
    if not transcript:
        raise TutorError("Fake vision mode only reads lines written with northstar.write().")
    return transcript_board(problem, transcript, lines)


async def check_plan(problem: str, plan: str, lang: str = "en") -> dict:
    # Keyword-judged so the plan flow can be tested free.
    text = plan.lower()
    if any(w in text for w in ("distribute", "expand", "multiply out")):
        return {"verdict": "good", "feedback": "That route gets you there. Drive it.",
                "spoken": "That route gets you there. Drive it."}
    if any(w in text for w in ("combine", "isolate", "both sides", "divide")):
        return {"verdict": "partial", "feedback": "Right direction. What has to happen to the parentheses first?",
                "spoken": "Right direction. What has to happen to the parentheses first?"}
    return {"verdict": "off", "feedback": "That route won't reach it. Look at the parentheses: what undoes them?",
            "spoken": "That route won't reach it. Look at the parentheses. What undoes them?"}


async def practice_problem(problem: str, wrong_latex: str, note: str, lang: str = "en") -> dict:
    # A fixed twin of the flagship demo problem, so the detour flow tests free.
    return {"problem": "Solve 3(x - 2) + 5 = 14", "latex": "3(x - 2) + 5 = 14",
            "skill": "distribute, then combine"}


async def read_problem(image_png_b64: str) -> dict:
    # No vision here; hand back a known worksheet so the capture and trip flows
    # can be tested free.
    return {"problems": [
        {"problem": "Solve 2(x - 3) + 4 = 10", "latex": "2(x - 3) + 4 = 10"},
        {"problem": "Solve x/3 + 1 = 5", "latex": "x/3 + 1 = 5"},
    ]}


async def explain_line(problem: str, lines: list[dict], line: int, detail: str, note: str = "",
                       lang: str = "en") -> dict:
    # `detail` can contain solution values; only the student-safe `note` is used.
    return {
        "hints": [
            f"Look closely at line {line}. Does it say the same thing as the line above it?",
            note or "Check each term as you carry it down.",
            f"Rewrite line {line} so it's equivalent to line {line - 1}.",
        ],
        "hint_ink": ["check each term", "carry it carefully", "rewrite this step"],
        "spoken_nudge": f"Recalculating. Take another look at line {line}.",
    }


async def ask(problem: str, question: str, image_png_b64: str | None, transcript: dict[int, str] | None,
              context: str, lang: str = "en") -> dict:
    return {"answer": f"(fake mode) You asked: {question}. Try comparing each line with the one above it."}
