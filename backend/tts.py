"""Neural GPS voice, proxied and cached.

Providers, in order of preference:
  grok        - xAI's /v1/tts, reusing the same XAI_API_KEY as the tutor
  elevenlabs  - with an ELEVENLABS_API_KEY

With neither key, /api/speak answers 503 and the app falls back to the
browser's speech synthesis. Repeated phrases ("Recalculating…") are served
from a small disk cache, so each distinct phrase costs credits once ever.
Force a provider with NORTHSTAR_TTS=grok|elevenlabs.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import urllib.request
from pathlib import Path

# Rachel: calm and even, the closest ElevenLabs stock voice to a nav system.
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
MODEL_ID = os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5")
# Gork: the team's pick for the GPS voice.
GROK_VOICE = os.environ.get("NORTHSTAR_TTS_VOICE", "gork")
CACHE = Path(__file__).with_name("tts_cache")


def eleven_key() -> str:
    return os.environ.get("ELEVENLABS_API_KEY", "").strip()


def xai_key() -> str:
    return (os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY") or "").strip()


def provider() -> str:
    """Which TTS to use: "grok", "elevenlabs", or "" for none."""
    explicit = os.environ.get("NORTHSTAR_TTS", "").strip().lower()
    if explicit in {"grok", "xai"}:
        return "grok" if xai_key() else ""
    if explicit in {"elevenlabs", "11labs"}:
        return "elevenlabs" if eleven_key() else ""
    if explicit in {"off", "none"}:
        return ""
    if xai_key():
        return "grok"
    if eleven_key():
        return "elevenlabs"
    return ""


def enabled() -> bool:
    return bool(provider())


def _post(url: str, payload: dict, headers: dict) -> bytes:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"content-type": "application/json", **headers}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read()


def _fetch_grok(text: str, lang: str) -> bytes:
    return _post("https://api.x.ai/v1/tts",
                 {"text": text, "voice_id": GROK_VOICE, "language": lang or "auto", "speed": 1.0},
                 {"authorization": f"Bearer {xai_key()}"})


def _fetch_elevenlabs(text: str, lang: str) -> bytes:
    return _post(f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}?output_format=mp3_44100_64",
                 {"text": text, "model_id": MODEL_ID,
                  "voice_settings": {"stability": 0.55, "similarity_boost": 0.6, "speed": 1.05}},
                 {"xi-api-key": eleven_key()})


def _fetch(text: str, lang: str) -> bytes:
    if provider() == "grok":
        return _fetch_grok(text, lang)
    return _fetch_elevenlabs(text, lang)


async def speak(text: str, lang: str = "en") -> bytes:
    prov = provider()
    voice = GROK_VOICE if prov == "grok" else VOICE_ID
    key = hashlib.sha256(f"{prov}|{voice}|{lang}|{text}".encode()).hexdigest()[:24]
    path = CACHE / f"{key}.mp3"
    if path.exists():
        return path.read_bytes()
    audio = await asyncio.to_thread(_fetch, text, lang)
    CACHE.mkdir(exist_ok=True)
    path.write_bytes(audio)
    return audio
