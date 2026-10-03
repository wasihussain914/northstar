"""The tutor reads the board and writes the guidance.

Claude is the default. Gemini (Google AI / Gemini Developer API) is used when
NORTHSTAR_PROVIDER=gemini, when NORTHSTAR_MODEL names a Gemini model, or when
only a Google AI key is set. Both clients stay in this module.

Two calls:
  read_board()    - vision: transcribe every numbered line, judge it, and
                    draft hints for the first wrong turn it sees.
  explain_line()  - text only: when SymPy finds a different first error than
                    the model did, write hints for the line SymPy flagged.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any

import anthropic
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types

# Sonnet 5.5 reads boards as accurately as Opus 5.5 in our tests at about half
# the latency (~4s vs ~6-8s per check), which matters for live feedback.
MODEL = os.environ.get("NORTHSTAR_MODEL", "claude-sonnet-5-5")
# Flash is the live-feedback counterpart to Sonnet: vision plus structured JSON,
# without a long thinking pass.
GEMINI_MODEL = "gemini-3.8-flash"

_client: anthropic.AsyncAnthropic | None = None
_gemini: genai.Client | None = None


def get_client() -> anthropic.AsyncAnthropic:
    # Created on first use so the server can start before a key is configured.
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic()
    return _client


def google_api_key() -> str:
    return (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()


def using_gemini() -> bool:
    """Claude unless the environment explicitly selects Gemini, or only a Google key is set."""
    explicit = os.environ.get("NORTHSTAR_PROVIDER", "").strip().lower()
    if explicit in {"gemini", "google"}:
        return True
    if explicit in {"claude", "anthropic"}:
        return False
    named = os.environ.get("NORTHSTAR_MODEL", "").strip().lower()
    if named.startswith("gemini"):
        return True
    return bool(google_api_key()) and not os.environ.get("ANTHROPIC_API_KEY")


def active_model() -> str:
    if using_gemini():
        explicit = os.environ.get("NORTHSTAR_GEMINI_MODEL", "").strip()
        if explicit:
            return explicit
        named = os.environ.get("NORTHSTAR_MODEL", "").strip()
        if named.startswith("gemini"):
            return named
        return GEMINI_MODEL
    named = os.environ.get("NORTHSTAR_MODEL", "").strip()
    if not named or named.startswith("gemini"):
        return "claude-sonnet-5-5"
    return named


def has_api_key() -> bool:
    if using_gemini():
        return bool(google_api_key())
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def get_gemini_client() -> genai.Client:
    global _gemini
    if _gemini is None:
        key = google_api_key()
        if not key:
            raise TutorError(
                "No Google AI API key found. Add GEMINI_API_KEY (or GOOGLE_API_KEY) to backend/.env "
                "and restart the server."
            )
        _gemini = genai.Client(api_key=key)
    return _gemini


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
- first_error_line: the first line marked error, or 0 if none.
- hints: exactly three hints for that line, from gentle to specific. Hint 1 points at where to look and asks a \
question. Hint 2 names the rule or idea that was misapplied. Hint 3 shows the corrected version of that one line \
only. Never state the final answer. Empty strings if there is no error.
- hint_ink: three very short phrases (at most four words each) a teacher would jot in red beside the wrong line—\
one per hint level, matching the same specificity as the corresponding hint. Write as a terse margin note, not a \
sentence: e.g. "check the sign", "add to both sides", "distribute first". No arrows, diagrams, line numbers, or \
final answers. Empty strings if there is no error.
- spoken_nudge: one short sentence (under 15 words) a GPS voice could say about the wrong turn, e.g. \
"Recalculating. Take another look at the sign in line 3." Empty if no error.
- next_step_hint: if the work so far is correct but unfinished, a Socratic nudge toward the next move, without \
doing it. Empty if finished or if there is an error.
- next_step_ink: a very short phrase (at most four words) matching next_step_hint for a teacher's red margin note, \
e.g. "isolate the variable", "combine terms". Empty if there is an error or the work is finished.
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
        "first_error_line": {"type": "integer"},
        "hints": {"type": "array", "items": {"type": "string"}},
        "hint_ink": {"type": "array", "items": {"type": "string"},
                     "description": "Three ≤4-word margin notes matching each hint level; empty strings if no error"},
        "spoken_nudge": {"type": "string"},
        "next_step_hint": {"type": "string"},
        "next_step_ink": {"type": "string",
                          "description": "≤4-word margin note matching next_step_hint; empty if no hint needed"},
        "on_track_message": {"type": "string"},
        "eta_steps": {"type": "integer"},
        "route_note": {"type": "string"},
    },
    "required": ["problem_sympy", "target_variable", "lines", "first_error_line", "hints", "hint_ink",
                 "spoken_nudge", "next_step_hint", "next_step_ink", "on_track_message", "eta_steps", "route_note"],
    "additionalProperties": False,
}

EXPLAIN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "hints": {"type": "array", "items": {"type": "string"}},
        "hint_ink": {"type": "array", "items": {"type": "string"},
                     "description": "Three ≤4-word margin notes matching each hint level"},
        "spoken_nudge": {"type": "string"},
    },
    "required": ["hints", "hint_ink", "spoken_nudge"],
    "additionalProperties": False,
}


def _gemini_contents(content: list[dict] | str) -> list:
    if isinstance(content, str):
        return [content]
    parts: list = []
    for block in content:
        if block.get("type") == "text":
            parts.append(block["text"])
        elif block.get("type") == "image":
            source = block["source"]
            parts.append(genai_types.Part.from_bytes(
                data=base64.b64decode(source["data"]),
                mime_type=source.get("media_type", "image/png"),
                # Handwriting and the small line numbers need more than the default resolution.
                media_resolution=genai_types.PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH,
            ))
    return parts


def _gemini_text(response: Any, *, declined: str, cutoff: str) -> str:
    try:
        text = (response.text or "").strip()
    except (ValueError, AttributeError):
        text = ""
    if text:
        return text
    candidates = getattr(response, "candidates", None) or []
    finish = getattr(candidates[0], "finish_reason", None) if candidates else None
    finish_name = getattr(finish, "name", str(finish or ""))
    if "MAX_TOKENS" in finish_name:
        raise TutorError(cutoff)
    if finish_name and finish_name not in {"STOP", "FINISH_REASON_UNSPECIFIED"}:
        raise TutorError(declined)
    prompt_feedback = getattr(response, "prompt_feedback", None)
    if getattr(prompt_feedback, "block_reason", None):
        raise TutorError(declined)
    raise TutorError("Gemini returned an empty reply.")


def _raise_gemini(exc: BaseException) -> None:
    if isinstance(exc, genai_errors.ClientError):
        if exc.code in (401, 403):
            raise TutorError("The Google AI API key is missing or invalid.") from exc
        if exc.code == 429:
            raise TutorError("Rate limited by the Google AI API; try again in a moment.") from exc
        raise TutorError(f"Google AI API error ({exc.code}): {exc.message or exc}") from exc
    if isinstance(exc, genai_errors.APIError):
        raise TutorError(f"Google AI API error ({exc.code}): {exc.message or exc}") from exc
    if type(exc).__name__ in {"ConnectError", "ConnectTimeout", "ReadTimeout", "TimeoutException", "NetworkError"}:
        raise TutorError("Couldn't reach the Google AI API. Check your connection.") from exc
    text = str(exc).lower()
    if "api key" in text or "authentication" in text or "credentials" in text:
        raise TutorError(
            "No Google AI API key found. Add GEMINI_API_KEY (or GOOGLE_API_KEY) to backend/.env "
            "and restart the server."
        ) from exc
    raise exc


async def _gemini_generate(content: list[dict] | str, schema: dict | None, max_tokens: int) -> Any:
    config: dict[str, Any] = {
        "system_instruction": SYSTEM,
        "max_output_tokens": max_tokens,
        "temperature": 0.2,
        # Low thinking keeps the feedback loop fast; SymPy double-checks the math.
        "thinking_config": genai_types.ThinkingConfig(thinking_level=genai_types.ThinkingLevel.LOW),
    }
    if schema is not None:
        config["response_mime_type"] = "application/json"
        config["response_json_schema"] = schema
    try:
        return await get_gemini_client().aio.models.generate_content(
            model=active_model(),
            contents=_gemini_contents(content),
            config=genai_types.GenerateContentConfig(**config),
        )
    except TutorError:
        raise
    except Exception as exc:
        _raise_gemini(exc)


async def _structured_gemini(content: list[dict] | str, schema: dict, max_tokens: int) -> dict:
    response = await _gemini_generate(content, schema, max_tokens)
    text = _gemini_text(response, declined="Gemini declined to read this board.", cutoff="Gemini's reply was cut off.")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise TutorError("Gemini returned malformed JSON.") from exc
    if not isinstance(data, dict):
        raise TutorError("Gemini returned malformed JSON.")
    return data


async def _structured(content: list[dict] | str, schema: dict, max_tokens: int = 8000) -> dict:
    if using_gemini():
        return await _structured_gemini(content, schema, max_tokens)
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
                     typed: dict[int, str] | None = None) -> dict:
    labels = ", ".join(str(n) for n in line_numbers) or "none"
    text = (f"Problem the student is solving: {problem or '(not given; infer it from the board)'}\n"
            f"Labeled lines on the board: {labels}")
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


ASK_INSTRUCTIONS = """The student just asked you a question out loud while working. Answer it as North Star: \
in at most three short sentences, warm and concrete, guiding rather than solving. Never state the final answer, \
even if asked directly; offer the next nudge instead. Your answer will be read aloud by a speech synthesizer, so \
write math in words a person would say ("two x minus six equals ten"), with no LaTeX, symbols or markdown."""


async def ask(problem: str, question: str, image_png_b64: str | None, transcript: dict[int, str] | None,
              context: str) -> dict:
    content: list[dict] = []
    if image_png_b64:
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                                    "data": image_png_b64}})
    content.append({"type": "text", "text": (
        f"{ASK_INSTRUCTIONS}\n\nProblem: {problem or '(not given)'}\n"
        f"What the last check found:\n{context or '(no check yet)'}\n\n"
        f"Student's question: {question}")})
    if using_gemini():
        response = await _gemini_generate(content, None, 4000)
        answer = _gemini_text(
            response,
            declined="Gemini declined to answer that.",
            cutoff="Gemini's reply was cut off.",
        )
        return {"answer": answer}
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


async def explain_line(problem: str, lines: list[dict], line: int, detail: str, note: str = "") -> dict:
    work = "\n".join(f"line {l['line']}: {l['latex']}" for l in lines if l.get("latex"))
    prompt = (f"Problem: {problem}\n\nThe student's work so far:\n{work}\n\n"
              f"A symbolic algebra check found that line {line} does not follow from the line before it"
              f"{' (for you only: ' + detail + ')' if detail else ''}.\n"
              f"Write hints, hint_ink, and spoken_nudge for line {line}, following the same rules as before. "
              f"hint_ink is three margin notes of at most four words each, one per hint: words a teacher would "
              f"jot in red beside that line. No diagram, no arrows, no line numbers, and no final answer. "
              f"Do not reveal the final answer or any solution values.")
    return await _structured(prompt, EXPLAIN_SCHEMA, max_tokens=4000)
