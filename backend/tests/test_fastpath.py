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


def test_unparseable_typed_text_falls_back_to_the_model(monkeypatch):
    called = {}

    async def fake_read(problem, image, lines, typed=None, lang="en"):
        called["read"] = True
        return {"problem_sympy": "", "target_variable": "", "task": "", "lines": [],
                "next_step_hint": "", "next_step_ink": "", "on_track_message": "",
                "eta_steps": 0, "route_note": ""}

    monkeypatch.setattr(tutor, "read_board", fake_read)
    run_check(monkeypatch, {1: "hello there this is prose"}, [1])
    assert called.get("read")
