"""The detour: /api/practice makes a twin problem for the skill just missed."""

import asyncio

import pytest
from fastapi import HTTPException

import fake_tutor
from main import PracticeRequest, practice
from tutor import PRACTICE_RULES, PRACTICE_SCHEMA


def test_practice_rules_never_ask_for_the_answer():
    assert "Do not include the answer" in PRACTICE_RULES
    assert set(PRACTICE_SCHEMA["required"]) == {"problem", "latex", "skill"}


def test_endpoint_returns_a_twin_in_fake_mode(monkeypatch):
    import main
    monkeypatch.setattr(main, "FAKE_VISION", True)
    out = asyncio.run(practice(PracticeRequest(
        problem="Solve 2(x - 3) + 4 = 10", wrong_line="2x + 2 = 10", note="")))
    assert out["problem"].startswith("Solve") and out["problem"] != "Solve 2(x - 3) + 4 = 10"
    assert out["latex"] and out["skill"]


def test_endpoint_rejects_an_empty_twin(monkeypatch):
    import main
    monkeypatch.setattr(main, "FAKE_VISION", True)

    async def empty(*args, **kwargs):
        return {"problem": ""}

    monkeypatch.setattr(fake_tutor, "practice_problem", empty)
    with pytest.raises(HTTPException) as err:
        asyncio.run(practice(PracticeRequest(problem="p", wrong_line="w", note="")))
    assert err.value.status_code == 422
