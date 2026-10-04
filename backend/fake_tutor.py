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
    lower = text.lower()
    if "?" in text or lower.startswith(("help", "what", "how", "why", "im not sure", "i'm not sure")):
        return "question"
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
    prev = next((l.get("latex") for l in lines if l.get("line") == line - 1), None)
    return {
        "hints": [
            f"Look closely at line {line}. Does it say the same thing as the line above it?",
            note or "Check each term as you carry it down.",
            f"Rewrite line {line} so it's equivalent to line {line - 1}.",
        ],
        "hint_ink": ["check each term", "carry it carefully", "rewrite this step"],
        "fix_line": prev or "2x - 6 + 4 = 10",
        "spoken_nudge": f"Recalculating. Take another look at line {line}.",
    }


async def ask(problem: str, question: str, image_png_b64: str | None, transcript: dict[int, str] | None,
              context: str, lang: str = "en", want_ink: bool = False) -> dict:
    out = {"answer": f"(fake mode) You asked: {question}. Try comparing each line with the one above it."}
    if want_ink:
        out["ink"] = "compare with above"
    return out


_CANNED_FINISH = {
    "2(x - 3) + 4 = 10": ["2x - 6 + 4 = 10", "2x - 2 = 10", "2x = 12", "x = 6"],
    "x/3 + 1 = 5": ["x/3 = 4", "x = 12"],
    "x^2 = 5x": ["x^2 - 5x = 0", "x(x - 5) = 0", "x = 0 or x = 5"],
}


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text.replace("−", "-").replace("²", "^2")).lower()


async def finish_work(problem: str, lines: list[dict], lang: str = "en") -> dict:
    """Finish the solve without a model: a canned route for the demo problems,
    else just the solved form from SymPy."""
    math = _norm(_problem_math(problem))
    written = [_norm(l.get("text", "")) for l in lines if l.get("text")]
    for key, route in _CANNED_FINISH.items():
        if _norm(key) == math:
            done = 0
            for i, step in enumerate(route):
                if _norm(step) in written:
                    done = i + 1
            return {"steps": route[done:]}
    try:
        import sympy as sp
        src = _problem_math(problem).replace("−", "-").replace("²", "^2").replace("^", "**")
        src = re.sub(r"(\d)([a-z(])", r"\1*\2", src)
        lhs, rhs = src.split("=", 1)
        expr = sp.sympify(lhs) - sp.sympify(rhs)
        var = sorted(expr.free_symbols, key=str)
        if len(var) != 1:
            raise ValueError("not a single-variable equation")
        roots = sp.solve(expr, var[0])
        if not roots:
            raise ValueError("no solution")
        return {"steps": [" or ".join(f"{var[0]} = {sp.nsimplify(r)}" for r in roots)]}
    except Exception as exc:  # noqa: BLE001
        raise TutorError("Fake mode can only finish simple single-variable equations.") from exc
