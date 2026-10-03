"""The tutor reads the board and writes the guidance.

Claude is the default. Gemini (Google AI / Gemini Developer API) is used when
NORTHSTAR_PROVIDER=gemini, when NORTHSTAR_MODEL names a Gemini model, or when
only a Google AI key is set. Grok (xAI) works the same way: NORTHSTAR_PROVIDER=grok,
a NORTHSTAR_MODEL starting with "grok", or only an XAI_API_KEY set. All clients
stay in this module.

Two calls:
  read_board()    - vision: transcribe every numbered line and judge it. Kept
                    small so the common no-error check stays fast.
  explain_line()  - text only: write the hint ladder for the first wrong turn,
                    whoever found it (SymPy or read_board's verdicts).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import urllib.error
import urllib.request
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
# Grok 4 is xAI's multimodal flagship: vision plus strict structured JSON.
XAI_MODEL = "grok-4"

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


def xai_api_key() -> str:
    return (os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY") or "").strip()


def using_grok() -> bool:
    """Grok when explicitly selected, or when only an xAI key is set."""
    explicit = os.environ.get("NORTHSTAR_PROVIDER", "").strip().lower()
    if explicit in {"grok", "xai"}:
        return True
    if explicit:
        return False
    named = os.environ.get("NORTHSTAR_MODEL", "").strip().lower()
    if named.startswith("grok"):
        return True
    return bool(xai_api_key()) and not os.environ.get("ANTHROPIC_API_KEY") and not google_api_key()


def using_gemini() -> bool:
    """Claude unless the environment explicitly selects Gemini, or only a Google key is set."""
    explicit = os.environ.get("NORTHSTAR_PROVIDER", "").strip().lower()
    if explicit in {"gemini", "google"}:
        return True
    if explicit in {"claude", "anthropic", "grok", "xai"}:
        return False
    named = os.environ.get("NORTHSTAR_MODEL", "").strip().lower()
    if named.startswith("gemini"):
        return True
    if named.startswith("grok"):
        return False
    return bool(google_api_key()) and not os.environ.get("ANTHROPIC_API_KEY")


def active_model() -> str:
    if using_grok():
        explicit = os.environ.get("NORTHSTAR_XAI_MODEL", "").strip()
        if explicit:
            return explicit
        named = os.environ.get("NORTHSTAR_MODEL", "").strip()
        if named.startswith("grok"):
            return named
        return XAI_MODEL
    if using_gemini():
        explicit = os.environ.get("NORTHSTAR_GEMINI_MODEL", "").strip()
        if explicit:
            return explicit
        named = os.environ.get("NORTHSTAR_MODEL", "").strip()
        if named.startswith("gemini"):
            return named
        return GEMINI_MODEL
    named = os.environ.get("NORTHSTAR_MODEL", "").strip()
    if not named or named.startswith("gemini") or named.startswith("grok"):
        return "claude-sonnet-5-5"
    return named


def has_api_key() -> bool:
    if using_grok():
        return bool(xai_api_key())
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


SYSTEM = """You are North Star, a patient math tutor that watches a student work on a whiteboard, \
like a GPS watching a driver. The student is the driver: you never solve the problem for them.

You cover algebra, trigonometry, single- and multivariable calculus, ordinary and partial differential \
equations, linear algebra, and discrete math (sums, proofs, induction, the pigeonhole principle, and \
elementary number theory). A chemical equation to balance, or a physics problem that is really an equation \
or a differential equation, uses the same rules.

The board image is ruled into numbered lines. Blue boxed numbers in the left margin are line labels added by \
the app; they are not part of the student's math. Each labeled line holds one step of the student's work.

For every labeled line:
- Transcribe exactly what the student wrote, not what they should have written. Copy their mistakes faithfully. \
If a line is ambiguous, pick the most likely reading.
- latex: the line as LaTeX (no surrounding $).
- sympy: the line in the dialect below. Leave it empty if the line is prose, crossed out, or clearly unfinished.
- If a line continues a chain of equal expressions (starts with "="), give just the expression after the "=".
- kind: equation, inequality, expression, crossed_out, not_math, or incomplete.
- ai_verdict: does this line follow correctly from the line before it (the first line follows from the problem)? \
ok, error, or unclear. A line that correctly carries forward an earlier mistake is ok; only the line where the \
mistake is made is an error.

Then guide the student:
- next_step_hint: if the work so far is correct but unfinished, a Socratic nudge toward the next move, without \
doing it. Empty if finished or if there is an error.
- next_step_ink: a very short phrase (at most four words) matching next_step_hint for a teacher's red margin note, \
e.g. "isolate the variable", "combine terms". Empty if there is an error or the work is finished.
- on_track_message: a few warm words of encouragement that fit where they are.
- eta_steps: your estimate of how many more lines a typical student needs to reach the answer from here.
- route_note: if there is a noticeably shorter or cleaner route than the one they are taking, mention it in one \
sentence without solving. Otherwise empty.
- task: what is being asked, one of solve, simplify, differentiate, integrate, limit, ode, pde, linalg, sum, \
number_theory, prove, pigeonhole, balance, physics, other.
- problem_sympy: the problem itself in the dialect below, or empty.
- target_variable: the variable being solved for (or differentiated or integrated with respect to), or empty.

Dialect for sympy and problem_sympy. Use * for multiplication (2*x). Single-letter variables only, plus C1, C2, ...
- Algebra and trig: + - * / ^ ( ) = < > <= >=, and sqrt, abs, log, ln, exp, factorial, binomial, sin, cos, tan, \
asin, acos, atan, sec, csc, cot, sinh, cosh, tanh, pi.
- Calculus: diff(f, x), diff(f, x, 2), diff(f, x, y), integrate(f, x), integrate(f, x, a, b), limit(f, x, a), \
limleft(f, x, a), limright(f, x, a), grad(f, x, y).
- Sums: summation(term, k, 1, n).
- ODEs: the unknown is a function, as in diff(y(x), x, 2) + y(x) = 0. A proposed solution is y(x) = .... \
Initial conditions follow a semicolon: diff(y(x), x) = 2*y(x); y(0) = 3. Physics motion is the same, \
e.g. diff(x(t), t, 2) = -g, task physics.
- PDEs: diff(u(x, t), t) = diff(u(x, t), x, 2). A proposed solution is u(x, t) = ....
- Linear algebra: matrices are [[1, 2], [3, 4]]. det([[1, 2], [3, 4]]), inv([[1, 2], [3, 4]]). \
To row-reduce a system, problem_sympy is the augmented matrix and each step is a matrix.
- Number theory: gcd(48, 18) with Euclid steps like 48 = 2*18 + 12, Mod(17, 5), modinv(3, 7), \
and congruences written 3*x = 1 mod 7.
- Proofs: task prove, and problem_sympy is the identity. A base case is base(1). For a summation formula the \
inductive step is the algebra showing the closed form at n+1, e.g. n*(n+1)/2 + (n+1) = (n+1)*(n+2)/2.
- Pigeonhole: pigeonhole(13, 12) for 13 items and 12 boxes. The student should reach the guaranteed minimum.
- Chemistry: balance(H2 + O2 = H2O). Coefficients use *, as in 2*H2 + O2 = 2*H2O. Formulas may contain \
parentheses, as in Ca(OH)2.

Keep every message short, kind and concrete. Refer to lines by number ("line 3")."""


def _str(desc: str) -> dict:
    return {"type": "string", "description": desc}


BOARD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "problem_sympy": _str("The problem in the SymPy dialect from the system prompt"),
        "target_variable": _str("Variable being solved for, or empty"),
        "task": {"type": "string", "enum": ["solve", "simplify", "differentiate", "integrate", "limit",
                                             "ode", "pde", "linalg", "sum", "number_theory", "prove",
                                             "pigeonhole", "balance", "physics", "other"]},
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
        "next_step_ink": {"type": "string",
                          "description": "≤4-word margin note matching next_step_hint; empty if no hint needed"},
        "on_track_message": {"type": "string"},
        "eta_steps": {"type": "integer"},
        "route_note": {"type": "string"},
    },
    "required": ["problem_sympy", "target_variable", "task", "lines",
                 "next_step_hint", "next_step_ink", "on_track_message", "eta_steps", "route_note"],
    "additionalProperties": False,
}

EXPLAIN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "hints": {"type": "array", "items": {"type": "string"}},
        "hint_ink": {"type": "array", "items": {"type": "string"},
                     "description": "Three ≤4-word margin notes matching each hint level"},
        "fix_line": {"type": "string",
                     "description": "The one corrected line the student should have written, plain text, no prose or LaTeX"},
        "spoken_nudge": {"type": "string"},
    },
    "required": ["hints", "hint_ink", "fix_line", "spoken_nudge"],
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


# --- Grok (xAI): OpenAI-compatible chat completions over stdlib HTTP ---

def _grok_messages(content: list[dict] | str) -> list[dict]:
    if isinstance(content, str):
        user: Any = content
    else:
        parts: list[dict] = []
        for block in content:
            if block.get("type") == "image":
                source = block["source"]
                parts.append({"type": "image_url", "image_url": {
                    "url": f"data:{source.get('media_type', 'image/png')};base64,{source['data']}",
                    "detail": "high"}})
            elif block.get("type") == "text":
                parts.append({"type": "text", "text": block["text"]})
        user = parts
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]


def _xai_request(payload: dict) -> dict:
    req = urllib.request.Request(
        "https://api.x.ai/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"authorization": f"Bearer {xai_api_key()}", "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.loads(response.read())


async def _grok_chat(content: list[dict] | str, schema: dict | None, max_tokens: int) -> str:
    if not xai_api_key():
        raise TutorError("No xAI API key found. Add XAI_API_KEY to backend/.env and restart the server.")
    payload: dict[str, Any] = {"model": active_model(), "messages": _grok_messages(content),
                               "max_tokens": max_tokens, "temperature": 0.2}
    if schema is not None:
        payload["response_format"] = {"type": "json_schema",
                                      "json_schema": {"name": "northstar", "strict": True, "schema": schema}}
    try:
        out = await asyncio.to_thread(_xai_request, payload)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:300]
        if exc.code in (401, 403):
            raise TutorError("The xAI API key is missing or invalid.") from exc
        if exc.code == 429:
            raise TutorError("Rate limited by the xAI API; try again in a moment.") from exc
        raise TutorError(f"xAI API error ({exc.code}): {body}") from exc
    except urllib.error.URLError as exc:
        raise TutorError("Couldn't reach the xAI API. Check your connection.") from exc
    try:
        text = out["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise TutorError("Grok returned an empty reply.") from exc
    if not text:
        raise TutorError("Grok returned an empty reply.")
    return text


async def _structured_grok(content: list[dict] | str, schema: dict, max_tokens: int) -> dict:
    text = await _grok_chat(content, schema, max_tokens)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise TutorError("Grok returned malformed JSON.") from exc
    if not isinstance(data, dict):
        raise TutorError("Grok returned malformed JSON.")
    return data


async def _structured(content: list[dict] | str, schema: dict, max_tokens: int = 8000) -> dict:
    if using_grok():
        return await _structured_grok(content, schema, max_tokens)
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


PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["good", "partial", "off"],
                    "description": "good: the route reaches the destination; partial: right direction, something "
                                   "missing or out of order; off: this route won't get there"},
        "feedback": _str("At most two short, warm sentences reacting to the plan - guiding, never solving"),
        "spoken": _str("The same feedback in plain spoken words, no symbols"),
    },
    "required": ["verdict", "feedback", "spoken"],
    "additionalProperties": False,
}

PLAN_RULES = """Before writing anything, the student described their plan for solving the whole problem, like a \
driver describing the route before pulling out. Judge the plan as a navigator would, without driving: verdict \
good when the route reaches the destination, partial when it's the right direction but a step is missing, vague \
or out of order, off when that route won't get there. feedback: at most two short, warm sentences — name what's \
right about the route, and if something is missing, point at where to look without doing the step for them. \
Never state the final answer or perform any algebra."""


async def check_plan(problem: str, plan: str, lang: str = "en") -> dict:
    prompt = (f"{PLAN_RULES}{lang_note(lang)}\n\nProblem: {problem or '(not given)'}\n\n"
              f"The student's plan, in their own words: {plan}")
    return await _structured(prompt, PLAN_SCHEMA, max_tokens=2000)


PRACTICE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "problem": _str("One new practice problem as one short line of plain text, same style as the original"),
        "latex": _str("Just the math as LaTeX (no surrounding $)"),
        "skill": _str("2-5 word name of the skill the mistake was about, e.g. 'distributing a negative'"),
    },
    "required": ["problem", "latex", "skill"],
    "additionalProperties": False,
}

PRACTICE_RULES = """The student just finished a problem where they took a wrong turn, caught it, and fixed it. \
Invent exactly ONE new practice problem that exercises the same skill they got wrong: same type and about the \
same difficulty as the original, but different numbers, a different answer, and ideally a slightly different \
shape so the skill transfers. Keep the instruction word ("Solve", "Differentiate", ...). Also name the skill in \
a few words. Do not include the answer or any solution steps anywhere."""


async def practice_problem(problem: str, wrong_latex: str, note: str, lang: str = "en") -> dict:
    prompt = (f"{PRACTICE_RULES}{lang_note(lang)}\n\nOriginal problem: {problem or '(not given)'}\n"
              f"The wrong line they wrote: {wrong_latex or '(unknown)'}\n"
              f"What went wrong there: {note or '(not recorded)'}")
    return await _structured(prompt, PRACTICE_SCHEMA, max_tokens=2000)


ASK_INSTRUCTIONS = """The student just asked you a question out loud while working. Answer it as North Star: \
in at most three short sentences, warm and concrete, guiding rather than solving. Never state the final answer, \
even if asked directly; offer the next nudge instead. Your answer will be read aloud by a speech synthesizer, so \
write math in words a person would say ("two x minus six equals ten"), with no LaTeX, symbols or markdown. \
Speak like a person: contractions, natural rhythm, warm and brief."""


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
    if using_grok():
        return {"answer": (await _grok_chat(content, None, 4000)).strip()}
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


HINT_RULES = """Write exactly three hints for that line, from gentle to specific. Hint 1 points at where to \
look and asks a question. Hint 2 names the rule or idea that was misapplied. Hint 3 shows the corrected version \
of that one line only. Never state the final answer or any solution values, in any hint.
Also write hint_ink: three very short margin notes (at most four words each), one per hint level, with matching \
specificity: words a teacher would jot in red beside that line (e.g. "check the sign"), not a sentence. \
No diagram, no arrows, no line numbers, and no final answer.
Also write fix_line: the one line the student should have written instead, as plain text \
(e.g. "2x - 6 + 4 = 10"). No prose, no LaTeX commands. No diagram. Never the final answer unless that one \
line is itself the last step.
Also write spoken_nudge: one short sentence (under 15 words) a GPS voice could say about the wrong turn, e.g. \
"Recalculating. Take another look at the sign in line 3." Write it the way a calm human navigator would \
actually say it out loud — contractions and natural rhythm, never a stiff script."""


async def explain_line(problem: str, lines: list[dict], line: int, detail: str, note: str = "",
                       lang: str = "en") -> dict:
    work = "\n".join(f"line {l['line']}: {l['latex']}" for l in lines if l.get("latex"))
    prompt = (f"Problem: {problem}\n\nThe student's work so far:\n{work}\n\n"
              f"Line {line} is the first wrong turn: it does not follow from the line before it"
              f"{' (for you only: ' + detail + ')' if detail else ''}.\n{HINT_RULES}{lang_note(lang)}")
    return await _structured(prompt, EXPLAIN_SCHEMA, max_tokens=4000)
