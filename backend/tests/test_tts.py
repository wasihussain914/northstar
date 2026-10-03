"""The neural GPS voice: keyless -> 503 fallback; phrases cached on disk."""

import asyncio

import pytest
from fastapi import HTTPException

import tts
from main import SpeakRequest, speak


def test_without_a_key_the_endpoint_says_use_browser_speech(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    assert not tts.enabled()
    with pytest.raises(HTTPException) as err:
        asyncio.run(speak(SpeakRequest(text="Recalculating.")))
    assert err.value.status_code == 503


def test_each_phrase_is_fetched_once_then_cached(monkeypatch, tmp_path):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "k")
    monkeypatch.setattr(tts, "CACHE", tmp_path)
    calls = []

    def fake_fetch(text):
        calls.append(text)
        return b"mp3-bytes"

    monkeypatch.setattr(tts, "_fetch", fake_fetch)
    assert asyncio.run(tts.speak("You have arrived.")) == b"mp3-bytes"
    assert asyncio.run(tts.speak("You have arrived.")) == b"mp3-bytes"
    assert calls == ["You have arrived."]
    assert len(list(tmp_path.glob("*.mp3"))) == 1
