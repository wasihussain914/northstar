"""Teacher-pen fields travel with the hints the model already returns."""

from __future__ import annotations

import asyncio

import fake_tutor
import tutor


def test_schemas_require_margin_ink() -> None:
    assert "hint_ink" in tutor.BOARD_SCHEMA["required"]
    assert "next_step_ink" in tutor.BOARD_SCHEMA["required"]
    assert "hint_ink" in tutor.EXPLAIN_SCHEMA["required"]
    assert "jot in red" in tutor.SYSTEM
    assert "next_step_ink" in tutor.SYSTEM


def test_fake_tutor_writes_short_margin_notes() -> None:
    board = asyncio.run(fake_tutor.read_board(
        "Solve 2(x - 3) + 4 = 10", {1: "2*x - 6 + 4 = 10"}, [1]))
    assert board["next_step_ink"]
    assert len(board["next_step_ink"].split()) <= 4
    explained = asyncio.run(fake_tutor.explain_line("p", [], 2, "detail", "note"))
    assert explained["hint_ink"] == ["check each term", "carry it carefully", "rewrite this step"]
    assert all(len(phrase.split()) <= 4 for phrase in explained["hint_ink"])


def test_explain_line_asks_for_margin_ink(monkeypatch) -> None:
    seen: dict = {}

    async def fake(prompt, schema, max_tokens=8000):
        seen["prompt"] = prompt
        seen["schema"] = schema
        return {"hints": ["look"], "hint_ink": ["check the sign"], "spoken_nudge": "Recalculating."}

    monkeypatch.setattr(tutor, "_structured", fake)
    out = asyncio.run(tutor.explain_line("2x = 4", [{"line": 1, "latex": "2x = 4"}], 1, "diff", "note"))
    assert out["hint_ink"] == ["check the sign"]
    assert seen["schema"] is tutor.EXPLAIN_SCHEMA
    assert "hint_ink" in seen["prompt"]
    assert "No diagram" in seen["prompt"]
