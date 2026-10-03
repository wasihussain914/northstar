"""Provider selection: Claude stays the default, Gemini is opt-in."""

from __future__ import annotations

import asyncio
import base64

import pytest

import tutor


def _clear(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "NORTHSTAR_PROVIDER",
        "NORTHSTAR_MODEL",
        "NORTHSTAR_GEMINI_MODEL",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    tutor._gemini = None


def test_defaults_to_claude(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear(monkeypatch)
    assert tutor.using_gemini() is False
    assert tutor.active_model() == "claude-sonnet-5-5"
    assert tutor.has_api_key() is False


def test_only_google_key_selects_gemini(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    assert tutor.using_gemini() is True
    assert tutor.active_model() == tutor.GEMINI_MODEL
    assert tutor.has_api_key() is True


def test_both_keys_stay_on_claude_until_provider_is_set(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant")
    monkeypatch.setenv("GOOGLE_API_KEY", "google")
    assert tutor.using_gemini() is False
    assert tutor.has_api_key() is True
    monkeypatch.setenv("NORTHSTAR_PROVIDER", "gemini")
    assert tutor.using_gemini() is True
    assert tutor.active_model() == tutor.GEMINI_MODEL


def test_gemini_model_name_selects_gemini(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("NORTHSTAR_MODEL", "gemini-3.8-flash")
    assert tutor.using_gemini() is True
    assert tutor.active_model() == "gemini-3.8-flash"


def test_explicit_claude_wins_over_a_google_key(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("NORTHSTAR_PROVIDER", "claude")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    assert tutor.using_gemini() is False


def test_missing_gemini_key_explains_where_to_put_it(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("NORTHSTAR_PROVIDER", "gemini")
    with pytest.raises(tutor.TutorError, match="GEMINI_API_KEY"):
        tutor.get_gemini_client()


def test_gemini_contents_keep_the_image_and_the_prompt() -> None:
    raw = base64.b64encode(b"\x89PNG").decode()
    parts = tutor._gemini_contents([
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": raw}},
        {"type": "text", "text": "line 1"},
    ])
    assert parts[1] == "line 1"
    assert parts[0].inline_data.mime_type == "image/png"
    assert parts[0].inline_data.data == b"\x89PNG"


def test_structured_uses_gemini_when_selected(monkeypatch: pytest.MonkeyPatch) -> None:
    _clear(monkeypatch)
    monkeypatch.setenv("NORTHSTAR_PROVIDER", "gemini")

    async def fake(content, schema, max_tokens):
        assert content == "prompt"
        assert max_tokens == 12
        return {"spoken_nudge": "ok"}

    monkeypatch.setattr(tutor, "_structured_gemini", fake)
    assert asyncio.run(tutor._structured("prompt", {}, 12)) == {"spoken_nudge": "ok"}
