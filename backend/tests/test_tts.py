"""The neural GPS voice: provider choice, keyless 503 fallback, disk cache."""

import asyncio

import pytest
from fastapi import HTTPException

import tts
from main import SpeakRequest, speak


def no_keys(monkeypatch):
    for var in ("XAI_API_KEY", "GROK_API_KEY", "ELEVENLABS_API_KEY", "NORTHSTAR_TTS"):
        monkeypatch.delenv(var, raising=False)


def test_without_keys_the_endpoint_says_use_browser_speech(monkeypatch):
    no_keys(monkeypatch)
    assert tts.provider() == "" and not tts.enabled()
    with pytest.raises(HTTPException) as err:
        asyncio.run(speak(SpeakRequest(text="Recalculating.")))
    assert err.value.status_code == 503


def test_grok_is_preferred_when_the_tutor_key_exists(monkeypatch):
    no_keys(monkeypatch)
    monkeypatch.setenv("XAI_API_KEY", "k")
    assert tts.provider() == "grok"
    monkeypatch.setenv("ELEVENLABS_API_KEY", "e")
    assert tts.provider() == "grok"
    monkeypatch.setenv("NORTHSTAR_TTS", "elevenlabs")
    assert tts.provider() == "elevenlabs"
    monkeypatch.setenv("NORTHSTAR_TTS", "off")
    assert tts.provider() == ""


def test_each_phrase_is_fetched_once_then_cached(monkeypatch, tmp_path):
    no_keys(monkeypatch)
    monkeypatch.setenv("XAI_API_KEY", "k")
    monkeypatch.setattr(tts, "CACHE", tmp_path)
    calls = []

    def fake_fetch(text, lang):
        calls.append((text, lang))
        return b"mp3-bytes"

    monkeypatch.setattr(tts, "_fetch", fake_fetch)
    assert asyncio.run(tts.speak("You have arrived.", "en")) == b"mp3-bytes"
    assert asyncio.run(tts.speak("You have arrived.", "en")) == b"mp3-bytes"
    assert calls == [("You have arrived.", "en")]
    # A different language is a different phrase.
    asyncio.run(tts.speak("You have arrived.", "es"))
    assert len(calls) == 2
    assert len(list(tmp_path.glob("*.mp3"))) == 2


def test_grok_request_shape(monkeypatch):
    no_keys(monkeypatch)
    monkeypatch.setenv("XAI_API_KEY", "k")
    seen = {}

    def fake_post(url, payload, headers):
        seen.update({"url": url, **payload})
        return b"audio"

    monkeypatch.setattr(tts, "_post", fake_post)
    assert tts._fetch("Recalculating.", "es") == b"audio"
    assert seen["url"].endswith("/v1/tts")
    assert seen["voice_id"] == "eve" and seen["language"] == "es"
