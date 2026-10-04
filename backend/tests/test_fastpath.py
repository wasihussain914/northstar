"""Valid typed chains skip the model; ambiguous steps get contextual review."""

import asyncio
import base64

import pytest

import main
import fake_tutor
import tutor

TINY_PNG = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c626060f80f00000500010d0a2db40000000049454e44ae426082")).decode()


class DirectPool:
    async def check(self, problem, steps, target, task=""):
        import verify
        return verify.check_steps(problem, steps, target, task)


async def never_read(*args, **kwargs):
    raise AssertionError("the model should not be called on the typed fast path")


def run_check(monkeypatch, transcript, lines):
    monkeypatch.setattr(main, "FAKE_VISION", False)
    monkeypatch.setattr(main, "sympy_pool", DirectPool())
    req = main.CheckRequest(problem="Solve 2(x - 3) + 4 = 10", image=TINY_PNG,
                            lines=lines, transcript=transcript)
    return asyncio.run(main.check(req))


def test_all_typed_lines_verify_without_a_model(monkeypatch):
    monkeypatch.setattr(tutor, "read_board", never_read)
    out = run_check(monkeypatch, {1: "2x - 6 + 4 = 10", 2: "2x - 2 = 10"}, [1, 2])
    assert [(l["line"], l["status"], l["source"]) for l in out["lines"]] == \
        [(1, "ok", "verified"), (2, "ok", "verified")]


def test_typed_wrong_turn_still_gets_model_hints(monkeypatch):
    seen = {}

    async def fake_read(problem, image, lines, typed=None, lang="en"):
        seen["read"] = True
        return fake_tutor.transcript_board(problem, typed, lines)

    async def fake_explain(problem, lines, line, detail, note="", lang="en"):
        seen["line"] = line
        return {"hints": ["look", "rule", "fix"], "hint_ink": ["a", "b", "c"], "spoken_nudge": "Recalculating."}

    monkeypatch.setattr(tutor, "explain_line", fake_explain)
    monkeypatch.setattr(tutor, "read_board", fake_read)
    out = run_check(monkeypatch, {1: "2x - 6 + 4 = 10", 2: "2x + 2 = 10"}, [1, 2])
<<<<<<< HEAD
    assert out["first_error"] == 2 and seen["line"] == 2 and seen["read"]


@pytest.mark.parametrize("text", ["u = x^2 + 1", "characteristic equation"])
def test_typed_independent_work_gets_context_and_does_not_break_chain(monkeypatch, text):
    seen = {}

    async def fake_read(problem, image, lines, typed=None, lang="en"):
        seen["read"] = True
        board = fake_tutor.transcript_board(problem, typed, lines)
        board["lines"][1].update(kind="intermediate", ai_verdict="ok")
        return board

    monkeypatch.setattr(tutor, "read_board", fake_read)
    monkeypatch.setattr(tutor, "explain_line", never_read)
    out = run_check(monkeypatch, {1: "2x - 2 = 10", 2: text, 3: "2x = 12"}, [1, 2, 3])
    assert seen["read"]
    assert [l["status"] for l in out["lines"]] == ["ok", "skip", "ok"]
    assert out["first_error"] is None
    assert out["hints"] == []
    assert out["arrived"] is False
=======
    # The check never waits on the hint call; the client asks /api/hints after.
    assert out["first_error"] == 2 and out["hints"] == [] and "line" not in seen

    req = main.HintsRequest(problem="Solve 2(x - 3) + 4 = 10", first_error=2,
                            lines=[out["known"][l] for l in (1, 2)], line_numbers=[1, 2],
                            known_problem=out["known_problem"])
    hints = asyncio.run(main.hints(req))
    assert seen["line"] == 2 and hints["hints"] == ["look", "rule", "fix"]


KNOWN = {1: {"latex": "2x - 6 + 4 = 10", "sympy": "2*x - 6 + 4 = 10", "kind": "equation", "ai_verdict": "ok"},
         2: {"latex": "2x - 2 = 10", "sympy": "2*x - 2 = 10", "kind": "equation", "ai_verdict": "ok"}}
KNOWN_PROBLEM = {"problem_sympy": "2*(x - 3) + 4 = 10", "target_variable": "x", "task": "solve"}


def test_lines_read_earlier_skip_the_model(monkeypatch):
    """Nothing new on the board (a line was erased): SymPy re-verifies, no model call."""
    monkeypatch.setattr(tutor, "read_board", never_read)
    monkeypatch.setattr(main, "FAKE_VISION", False)
    monkeypatch.setattr(main, "sympy_pool", DirectPool())
    req = main.CheckRequest(problem="Solve 2(x - 3) + 4 = 10", image=TINY_PNG, lines=[1, 2],
                            known=KNOWN, known_problem=KNOWN_PROBLEM)
    out = asyncio.run(main.check(req))
    assert [(l["line"], l["status"]) for l in out["lines"]] == [(1, "ok"), (2, "ok")]
    assert out["timing_ms"]["model_read"] is False and out["eta_steps"] == -1


def test_only_the_new_line_is_read(monkeypatch):
    """Known lines go to the model as text; it reads just the new one and the rest is spliced back."""
    got = {}

    async def fake_read(problem, image, lines, typed=None, lang="en", known=None):
        got["known"] = sorted(known)
        return {"problem_sympy": "2*(x - 3) + 4 = 10", "target_variable": "x", "task": "solve",
                "lines": [{"line": 3, "latex": "2x = 12", "sympy": "2*x = 12", "kind": "equation",
                           "ai_verdict": "ok"}],
                "next_step_hint": "divide", "next_step_ink": "divide both sides", "on_track_message": "",
                "eta_steps": 1, "route_note": ""}

    monkeypatch.setattr(tutor, "read_board", fake_read)
    monkeypatch.setattr(main, "FAKE_VISION", False)
    monkeypatch.setattr(main, "sympy_pool", DirectPool())
    req = main.CheckRequest(problem="Solve 2(x - 3) + 4 = 10", image=TINY_PNG, lines=[1, 2, 3],
                            known=KNOWN, known_problem=KNOWN_PROBLEM)
    out = asyncio.run(main.check(req))
    assert got["known"] == [1, 2]
    assert [(l["line"], l["status"], l["source"]) for l in out["lines"]] == \
        [(1, "ok", "verified"), (2, "ok", "verified"), (3, "ok", "verified")]
    assert out["timing_ms"]["model_read"] is True and out["timing_ms"]["lines_read"] == 1
    assert set(out["known"]) == {1, 2, 3}
>>>>>>> origin/main


def test_unparseable_typed_text_falls_back_to_the_model(monkeypatch):
    called = {}

    async def fake_read(problem, image, lines, typed=None, lang="en", known=None):
        called["read"] = True
        return {"problem_sympy": "", "target_variable": "", "task": "", "lines": [],
                "next_step_hint": "", "next_step_ink": "", "on_track_message": "",
                "eta_steps": 0, "route_note": ""}

    monkeypatch.setattr(tutor, "read_board", fake_read)
    run_check(monkeypatch, {1: "hello there this is prose"}, [1])
    assert called.get("read")


def test_tiny_placeholder_images_become_a_readable_blank_page():
    import base64
    from main import decode_png, readable_png
    tiny = base64.b64encode(bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c626060f80f00000500010d0a2db40000000049454e44ae426082")).decode()
    b64, raw = decode_png(tiny)
    swapped = readable_png(b64, raw)
    assert swapped != b64 and len(swapped) > len(b64)
    # Real-size boards pass through untouched.
    big_b64, big_raw = decode_png(swapped)
    assert readable_png(big_b64, big_raw) == big_b64
