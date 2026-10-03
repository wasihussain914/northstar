"""Grok (xAI) as a tutor provider: selection, message shape, structured output."""

import asyncio
import json

import tutor


def grok_env(monkeypatch):
    monkeypatch.setenv("NORTHSTAR_PROVIDER", "grok")
    monkeypatch.setenv("XAI_API_KEY", "k")
    monkeypatch.delenv("NORTHSTAR_MODEL", raising=False)
    monkeypatch.delenv("NORTHSTAR_XAI_MODEL", raising=False)


def test_provider_selection(monkeypatch):
    grok_env(monkeypatch)
    assert tutor.using_grok() and not tutor.using_gemini()
    assert tutor.active_model() == tutor.XAI_MODEL
    assert tutor.has_api_key()


def test_only_an_xai_key_auto_selects_grok(monkeypatch):
    monkeypatch.delenv("NORTHSTAR_PROVIDER", raising=False)
    monkeypatch.delenv("NORTHSTAR_MODEL", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.setenv("XAI_API_KEY", "k")
    assert tutor.using_grok() and not tutor.using_gemini()


def test_read_board_goes_through_grok_with_image_and_schema(monkeypatch):
    grok_env(monkeypatch)
    seen = {}
    board = {"problem_sympy": "2*x = 4", "target_variable": "x", "task": "solve", "lines": [],
             "next_step_hint": "", "next_step_ink": "", "on_track_message": "hi", "eta_steps": 1,
             "route_note": ""}

    def fake_request(payload):
        seen.update(payload)
        return {"choices": [{"message": {"content": json.dumps(board)}}]}

    monkeypatch.setattr(tutor, "_xai_request", fake_request)
    out = asyncio.run(tutor.read_board("Solve 2x = 4", "UEhQ", [1]))
    assert out == board
    assert seen["model"] == tutor.XAI_MODEL
    assert seen["response_format"]["json_schema"]["strict"] is True
    system, user = seen["messages"]
    assert system == {"role": "system", "content": tutor.SYSTEM}
    assert user["content"][0]["type"] == "image_url"
    assert user["content"][0]["image_url"]["url"].startswith("data:image/png;base64,UEhQ")


def test_ask_goes_through_grok_as_plain_text(monkeypatch):
    grok_env(monkeypatch)
    seen = {}

    def fake_request(payload):
        seen.update(payload)
        return {"choices": [{"message": {"content": " two x is four "}}]}

    monkeypatch.setattr(tutor, "_xai_request", fake_request)
    out = asyncio.run(tutor.ask("Solve 2x = 4", "what now?", None, None, ""))
    assert out == {"answer": "two x is four"}
    assert "response_format" not in seen
