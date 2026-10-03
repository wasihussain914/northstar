"""Neural GPS voice: ElevenLabs text-to-speech, proxied and cached.

Optional: with no ELEVENLABS_API_KEY, /api/speak answers 503 and the app
falls back to the browser's speech synthesis. Repeated phrases
("Recalculating…") are served from a small disk cache, so each distinct
phrase costs credits once ever.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import urllib.request
from pathlib import Path

# Rachel: calm and even, the closest stock voice to a nav system.
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
# Flash is fast enough for live feedback and speaks all six guidance languages.
MODEL_ID = os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5")
CACHE = Path(__file__).with_name("tts_cache")


def api_key() -> str:
    return os.environ.get("ELEVENLABS_API_KEY", "").strip()


def enabled() -> bool:
    return bool(api_key())


def _fetch(text: str) -> bytes:
    req = urllib.request.Request(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}?output_format=mp3_44100_64",
        data=json.dumps({
            "text": text,
            "model_id": MODEL_ID,
            "voice_settings": {"stability": 0.55, "similarity_boost": 0.6, "speed": 1.05},
        }).encode(),
        headers={"xi-api-key": api_key(), "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        return response.read()


async def speak(text: str) -> bytes:
    key = hashlib.sha256(f"{VOICE_ID}|{MODEL_ID}|{text}".encode()).hexdigest()[:24]
    path = CACHE / f"{key}.mp3"
    if path.exists():
        return path.read_bytes()
    audio = await asyncio.to_thread(_fetch, text)
    CACHE.mkdir(exist_ok=True)
    path.write_bytes(audio)
    return audio
