"""Claude reads the board and writes the guidance.

Two calls:
  read_board()    - vision: transcribe every numbered line and judge it. Kept
                    small so the common no-error check stays fast.
  explain_line()  - text only: write the hint ladder for the first wrong turn,
                    whoever found it (SymPy or read_board's verdicts).
"""

from __future__ import annotations

import json
import os
from typing import Any

import anthropic

# Sonnet 5.5 reads boards as accurately as Opus 5.5 in our tests at about half
# the latency (~4s vs ~6-8s per check), which matters for live feedback.
MODEL = os.environ.get("NORTHSTAR_MODEL", "claude-sonnet-5-5")

_client: anthropic.AsyncAnthropic | None = None


def get_client() -> anthropic.AsyncAnthropic:
    # Created on first use so the server can start before a key is configured.
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic()
    return _client


class TutorError(RuntimeError):
    pass


SYSTEM = """You are North Star, a patient math tutor that watches a student work algebra on a whiteboard, \
like a GPS watching a driver. The student is the driver: you never solve the problem for them.

The board image is ruled into numbered lines. Blue boxed numbers in the left margin are line labels added by \
the app; they are not part of the student's math. Each labeled line holds one step of the student's work.

For every labeled line:
- Transcribe exactly what the student wrote, not what they should have written. Copy their mistakes faithfully. \
If a line is ambiguous, pick the most likely reading.
- latex: the line as LaTeX (no surrounding $).
- sympy: the line in plain SymPy syntax using only digits, single-letter variables, + - * / ^ ( ) and one of \
= < > <= >=, plus sqrt(), abs(), log(), exp(), pi. Write multiplication explicitly (2*x). Leave it empty if the \
line is not algebra, is crossed out, or is clearly unfinished.
- If a line continues a chain of equal expressions (starts with "="), give just the expression after the "=".
- kind: equation, inequality, expression, crossed_out, not_math, or incomplete.
- ai_verdict: does this line follow correctly from the line before it (the first line follows from the problem)? \
ok, error, or unclear. A line that correctly carries forward an earlier mistake is ok; only the line where the \
mistake is made is an error.

Then guide the student:
- next_step_hint: if the work so far is correct but unfinished, a Socratic nudge toward the next move, without \
doing it. Empty if finished or if there is an error.
- on_track_message: a few warm words of encouragement that fit where they are.
- eta_steps: your estimate of how many more lines a typical student needs to reach the answer from here.
- route_note: if there is a noticeably shorter or cleaner route than the one they are taking, mention it in one \
sentence without solving. Otherwise empty.
- problem_sympy: the problem itself in the same SymPy syntax (the equation or expression to work on), or empty.
- target_variable: the variable being solved for, or empty for simplify-type problems.

Keep every message short, kind and concrete. Refer to lines by number ("line 3")."""


def _str(desc: str) -> dict:
    return {"type": "string", "description": desc}


BOARD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "problem_sympy": _str("The problem in SymPy syntax"),
        "target_variable": _str("Variable being solved for, or empty"),
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": "integer"},
                    "latex": {"type": "string"},
                    "sympy": {"type": "string"},
                    "kind": {"type": "string", "enum": ["equation", "inequality", "expression", "crossed_out",
                                                        "not_math", "incomplete"]},
                    "ai_verdict": {"type": "string", "enum": ["ok", "error", "unclear"]},
                },
                "required": ["line", "latex", "sympy", "kind", "ai_verdict"],
                "additionalProperties": False,
            },
        },
        "next_step_hint": {"type": "string"},
        "on_track_message": {"type": "string"},
        "eta_steps": {"type": "integer"},
        "route_note": {"type": "string"},
    },
    "required": ["problem_sympy", "target_variable", "lines",
                 "next_step_hint", "on_track_message", "eta_steps", "route_note"],
    "additionalProperties": False,
}

EXPLAIN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "hints": {"type": "array", "items": {"type": "string"}},
        "spoken_nudge": {"type": "string"},
    },
    "required": ["hints", "spoken_nudge"],
    "additionalProperties": False,
}

PROBLEM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "problems": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "problem": _str("The problem as one short line of plain text, e.g. 'Solve 2(x − 3) + 4 = 10'"),
                    "latex": _str("Just the math as LaTeX (no surrounding $), or empty if there is none"),
                },
                "required": ["problem", "latex"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["problems"],
    "additionalProperties": False,
}

READ_PROBLEM = """The image is a crop of a student's homework (a photo or a PDF page). Find every distinct \
math problem in it, in reading order. For each one return:
- problem: the problem as one short line of plain text the app can display and reuse, keeping the instruction \
word if there is one ("Solve", "Simplify", ...) and adding a fitting one if there isn't. Drop problem numbers \
like "3)".
- latex: just the math as LaTeX, no surrounding $.
A tight crop around one problem returns exactly that one. Skip headings, instructions and worked examples; \
if there are no math problems at all, return an empty list."""

# Languages the tutor can guide in (student-facing text and speech only).
LANGUAGES = {"en": "English", "es": "Spanish", "fr": "French", "zh": "Simplified Chinese",
             "hi": "Hindi", "bn": "Bengali"}


def lang_note(lang: str) -> str:
    """Prompt line switching every student-facing message to the student's language."""
    if lang == "en" or lang not in LANGUAGES:
        return ""
    return (f"\n\nThe student speaks {LANGUAGES[lang]}: write every student-facing message (hints, nudges, "
            f"encouragement, route notes, next-step hints, spoken answers) in {LANGUAGES[lang]}. "
            "Keep latex and sympy fields exactly as written on the board.")


async def _structured(content: list[dict] | str, schema: dict, max_tokens: int = 8000) -> dict:
    try:
        response = await get_client().beta.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": content}],
            # Low effort keeps the feedback loop fast; the math itself is
            # double-checked by SymPy.
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.AuthenticationError as exc:
        raise TutorError("The Anthropic API key is missing or invalid.") from exc
    except anthropic.RateLimitError as exc:
        raise TutorError("Rate limited by the Anthropic API; try again in a moment.") from exc
    except anthropic.APIStatusError as exc:
        raise TutorError(f"Anthropic API error ({exc.status_code}): {exc.message}") from exc
    except anthropic.APIConnectionError as exc:
        raise TutorError("Couldn't reach the Anthropic API. Check your connection.") from exc
    except anthropic.AnthropicError as exc:
        raise TutorError(f"Anthropic client error: {exc}") from exc
    except TypeError as exc:
        # The SDK raises this before sending anything when no credentials are set.
        if "authentication" in str(exc):
            raise TutorError("No Anthropic API key found. Add ANTHROPIC_API_KEY to backend/.env "
                             "and restart the server.") from exc
        raise

    if response.stop_reason == "refusal":
        raise TutorError("Claude declined to read this board.")
    if response.stop_reason == "max_tokens":
        raise TutorError("Claude's reply was cut off.")
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise TutorError("Claude returned malformed JSON.") from exc


async def read_board(problem: str, image_png_b64: str, line_numbers: list[int],
                     typed: dict[int, str] | None = None, lang: str = "en") -> dict:
    labels = ", ".join(str(n) for n in line_numbers) or "none"
    text = (f"Problem the student is solving: {problem or '(not given; infer it from the board)'}\n"
            f"Labeled lines on the board: {labels}{lang_note(lang)}")
    if typed:
        known = "\n".join(f"line {n}: {t}" for n, t in sorted(typed.items()) if n in line_numbers)
        if known:
            text += ("\n\nThe student typed these lines on a keyboard, so this is exactly what they say "
                     f"(transcribe them from this text, not from the image):\n{known}")
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_png_b64}},
        {"type": "text", "text": text},
    ]
    return await _structured(content, BOARD_SCHEMA)


async def read_problem(image_png_b64: str) -> dict:
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image_png_b64}},
        {"type": "text", "text": READ_PROBLEM},
    ]
    return await _structured(content, PROBLEM_SCHEMA, max_tokens=2000)


ASK_INSTRUCTIONS = """The student just asked you a question out loud while working. Answer it as North Star: \
in at most three short sentences, warm and concrete, guiding rather than solving. Never state the final answer, \
even if asked directly; offer the next nudge instead. Your answer will be read aloud by a speech synthesizer, so \
write math in words a person would say ("two x minus six equals ten"), with no LaTeX, symbols or markdown."""


async def ask(problem: str, question: str, image_png_b64: str | None, transcript: dict[int, str] | None,
              context: str, lang: str = "en") -> dict:
    content: list[dict] = []
    if image_png_b64:
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                    "data": image_png_b64}})
    content.append({"type": "text", "text": (
        f"{ASK_INSTRUCTIONS}{lang_note(lang)}\n\nProblem: {problem or '(not given)'}\n"
        f"What the last check found:\n{context or '(no check yet)'}\n\n"
        f"Student's question: {question}")})
    try:
        response = await get_client().beta.messages.create(
            model=MODEL,
            max_tokens=4000,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": content}],
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.APIError as exc:
        raise TutorError(f"Couldn't get an answer: {exc}") from exc
    except TypeError as exc:
        if "authentication" in str(exc):
            raise TutorError("No Anthropic API key found. Add ANTHROPIC_API_KEY to backend/.env "
                             "and restart the server.") from exc
        raise
    if response.stop_reason == "refusal":
        raise TutorError("Claude declined to answer that.")
    answer = "".join(b.text for b in response.content if b.type == "text").strip()
    return {"answer": answer}


HINT_RULES = """Write exactly three hints for that line, from gentle to specific. Hint 1 points at where to \
look and asks a question. Hint 2 names the rule or idea that was misapplied. Hint 3 shows the corrected version \
of that one line only. Never state the final answer or any solution values, in any hint.
Also write spoken_nudge: one short sentence (under 15 words) a GPS voice could say about the wrong turn, e.g. \
"Recalculating. Take another look at the sign in line 3.\""""


async def explain_line(problem: str, lines: list[dict], line: int, detail: str, note: str = "",
                       lang: str = "en") -> dict:
    work = "\n".join(f"line {l['line']}: {l['latex']}" for l in lines if l.get("latex"))
    prompt = (f"Problem: {problem}\n\nThe student's work so far:\n{work}\n\n"
              f"Line {line} is the first wrong turn: it does not follow from the line before it"
              f"{' (for you only: ' + detail + ')' if detail else ''}.\n{HINT_RULES}{lang_note(lang)}")
    return await _structured(prompt, EXPLAIN_SCHEMA, max_tokens=4000)
