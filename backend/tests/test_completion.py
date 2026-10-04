"""Every board check verifies final answers against the original problem."""

import asyncio

import pytest

import main
import tutor
from tests.test_fastpath import DirectPool, TINY_PNG, never_read
from verify import check_steps


@pytest.mark.parametrize("problem,answer,target", [
    ("2x = 12", "6", "x"),
    ("2x = 12", "x = 6", ""),
    ("2x = 12", "6 = x", None),
    ("3x = 1", "1/3", "x"),
    ("x = sqrt(2)", "sqrt(2)", ""),
    ("2 + 4", "6", ""),
    ("1/2 + 1/4", "3/4", ""),
    ("sqrt(8)/2", "sqrt(2)", ""),
    ("2y + 4x = 8", "y = 4 - 2x", "y"),
])
def test_complete_answers(problem, answer, target):
    out = check_steps(problem, [(1, answer)], target)
    assert out["arrived"] is True
    assert out["results"][1]["final_answer"] is True
    assert out["results"][1]["verdict"] == "valid"


@pytest.mark.parametrize("problem,answer,target", [
    ("2x = 12", "5", "x"),
    ("x^2 = 9", "3", "x"),
    ("2x = 12", "2x = 12", "x"),
    ("2x = 12", "3 + 3", "x"),
    ("2 + 4", "5", ""),
    ("2 + 4", "3 + 3", ""),
    ("2x = 12", "y = 6", "x"),
    ("", "6", ""),
    ("sqrt(x) = -2", "x = 4", "x"),
])
def test_wrong_or_unfinished_answers(problem, answer, target):
    assert check_steps(problem, [(1, answer)], target)["arrived"] is False


def test_completion_checked_on_every_step():
    steps = [(1, "2x = 12"), (2, "x = 6"), (3, "2x = 12")]
    for count in range(1, 4):
        out = check_steps("2(x-3)+4 = 10", steps[:count], "x")
        assert out["arrived"] is (count >= 2)
    assert [row["final_answer"] for row in out["results"].values()] == [False, True, False]


def test_wrong_work_prevents_completion():
    out = check_steps("2x = 12", [(1, "x = 5"), (2, "x = 6")], "x")
    assert out["arrived"] is False


@pytest.mark.parametrize("problem,answer", [("2x = 12", "6"), ("2 + 4", "6"), ("2x = 12", "x = 6")])
def test_typed_completion_skips_model(monkeypatch, problem, answer):
    monkeypatch.setattr(main, "FAKE_VISION", False)
    monkeypatch.setattr(main, "sympy_pool", DirectPool())
    monkeypatch.setattr(tutor, "read_board", never_read)
    out = asyncio.run(main.check(main.CheckRequest(
        problem=problem, image=TINY_PNG, lines=[1], transcript={1: answer})))
    assert out["arrived"] is True
    assert out["eta_steps"] == 0
    assert out["next_step_hint"] == out["next_step_ink"] == ""


@pytest.mark.parametrize("problem,answer,target,final_answer,eta,arrived", [
    ("2x = 12", "2x = 12", "x", True, 0, False),
    ("2 + 4", "3 + 3", "", False, 0, False),
    ("", "6", "", False, 0, False),
    ("", "x = 6", "x", True, 2, True),
    ("2x = 12", "x = 6", "x", False, 2, True),
])
def test_handwritten_completion_uses_verification_not_eta(
        monkeypatch, problem, answer, target, final_answer, eta, arrived):
    async def read(*args, **kwargs):
        return {"problem_sympy": problem, "target_variable": target, "eta_steps": eta,
                "lines": [{"line": 1, "latex": answer, "sympy": answer, "kind": "equation",
                           "ai_verdict": "ok", "final_answer": final_answer}]}

    monkeypatch.setattr(main, "FAKE_VISION", False)
    monkeypatch.setattr(main, "sympy_pool", DirectPool())
    monkeypatch.setattr(tutor, "read_board", read)
    out = asyncio.run(main.check(main.CheckRequest(problem=problem, image=TINY_PNG, lines=[1])))
    assert out["arrived"] is arrived
    assert (out["eta_steps"] == 0) is arrived
