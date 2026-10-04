"""Autopilot: the rest of the solution, continuing from the student's last line."""

import asyncio

import pytest

import fake_tutor
import main


def run_finish(monkeypatch, problem, lines):
    monkeypatch.setattr(main, "FAKE_VISION", True)
    return asyncio.run(main.finish(main.FinishRequest(problem=problem, lines=lines)))


def test_continues_after_the_last_written_step(monkeypatch):
    out = run_finish(monkeypatch, "Solve 2(x − 3) + 4 = 10", [{"line": 1, "text": "2x - 6 + 4 = 10"}])
    assert out["steps"] == ["2x - 2 = 10", "2x = 12", "x = 6"]


def test_starts_from_the_problem_when_nothing_is_written(monkeypatch):
    out = run_finish(monkeypatch, "Solve 2(x - 3) + 4 = 10", [])
    assert out["steps"][0] == "2x - 6 + 4 = 10" and out["steps"][-1] == "x = 6"


def test_unknown_equation_gets_the_solved_form(monkeypatch):
    out = run_finish(monkeypatch, "Solve 3(x + 2) − 5 = 2x + 9", [{"line": 1, "text": "3x + 6 - 5 = 2x + 9"}])
    assert out["steps"] == ["x = 8"]


def test_quadratic_lists_both_roots():
    out = asyncio.run(fake_tutor.finish_work("Solve x² − 5x + 6 = 0", []))
    assert out["steps"] == ["x = 2 or x = 3"]


def test_unfinishable_problem_is_a_502(monkeypatch):
    with pytest.raises(Exception) as err:
        run_finish(monkeypatch, "Prove the pigeonhole principle", [])
    assert getattr(err.value, "status_code", None) == 502


def test_demo_integral_gets_the_canned_solution_in_any_spelling():
    from main import canned_finish, DEMO_FINISH
    full = DEMO_FINISH["integratex^2e^xdx"]
    for spelling in ("Integrate x^2 e^x dx", "integrate(x^2*exp(x), x)",
                     "∫ x^2 e^x dx", "Integrate x^2e^x dx"):
        assert canned_finish(spelling, []) == full, spelling
    # Lines already written are skipped — even sloppy ones missing the dx.
    done = [{"text": "u = x^2"}, {"text": "dv = e^x"}]
    rest = canned_finish("Integrate x^2 e^x dx", done)
    assert rest is not None and "u = x^2" not in rest and "dv = e^x dx" not in rest
    assert canned_finish("Integrate x e^x dx", []) is None
