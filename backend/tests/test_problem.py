"""The /api/problem flow (reading problems off a homework crop) and language plumbing."""

import asyncio
import base64

import pytest
from fastapi import HTTPException

import fake_tutor
from main import ProblemRequest, decode_png, problem
from tutor import lang_note

# A 1x1 white PNG, the smallest thing decode_png accepts.
TINY_PNG = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c626060f80f00000500010d0a2db40000000049454e44ae426082")).decode()


def test_fake_read_problem_returns_a_worksheet():
    out = asyncio.run(fake_tutor.read_problem(TINY_PNG))
    assert len(out["problems"]) == 2
    assert all(p["problem"].startswith("Solve") and p["latex"] for p in out["problems"])


def test_endpoint_returns_problems_in_fake_mode(monkeypatch):
    import main
    monkeypatch.setattr(main, "FAKE_VISION", True)
    out = asyncio.run(problem(ProblemRequest(image=f"data:image/png;base64,{TINY_PNG}")))
    assert [p["problem"] for p in out["problems"]] == ["Solve 2(x - 3) + 4 = 10", "Solve x/3 + 1 = 5"]


def test_endpoint_rejects_a_crop_with_no_problem(monkeypatch):
    import main
    monkeypatch.setattr(main, "FAKE_VISION", True)

    async def empty(_):
        return {"problems": [{"problem": "", "latex": ""}]}

    monkeypatch.setattr(fake_tutor, "read_problem", empty)
    with pytest.raises(HTTPException) as err:
        asyncio.run(problem(ProblemRequest(image=TINY_PNG)))
    assert err.value.status_code == 422


def test_decode_png_rejects_other_formats():
    with pytest.raises(HTTPException):
        decode_png(base64.b64encode(b"GIF89a not a png").decode())


def test_lang_note_switches_guidance_language():
    assert lang_note("en") == ""
    assert lang_note("klingon") == ""
    note = lang_note("es")
    assert "Spanish" in note and "latex" in note
