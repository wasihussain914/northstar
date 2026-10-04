"""Eval: study-guide problem 4, as a student would write it on the board.

    Prove that if C is a linear code, then the distance of C equals the
    minimum weight of non-zero codewords.

Six proof variants — one correct, five with a classic mistake planted on a
known line — are sent through /api/check and the tutor is graded on whether
it flags exactly the right line. Claims are judged by the model, so this
costs a few cents per run and is a judgment eval, not a unit test.

    uv run python evals/eval_problem4.py                # against the live site
    NORTHSTAR_EVAL_URL=http://127.0.0.1:8000 uv run python evals/eval_problem4.py
"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.request

URL = os.environ.get("NORTHSTAR_EVAL_URL", "https://northstar.wasihussain.com").rstrip("/")
PROBLEM = ("Prove that if C is a linear code, then the distance of C equals "
           "the minimum weight of non-zero codewords")

def blank_png(width: int = 480, height: int = 240) -> str:
    """A plain white PNG: the typed transcript carries the proof, but the
    vision model still wants a plausible board image."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + b"\xff" * (3 * width) for _ in range(height))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw))
           + chunk(b"IEND", b""))
    return base64.b64encode(png).decode()


TINY_PNG = blank_png()

GOOD = [
    "let m = min wt(u) for u in C, u != 0",
    "for any u in C with u != 0: d(u, 0) = wt(u)",
    "C linear, so 0 is in C",
    "so d <= wt(u) for every nonzero u, hence d <= m",
    "for distinct v, w in C: d(v, w) = wt(v + w)",
    "C linear, so v + w is in C, and v + w != 0",
    "so d(v, w) >= m for all distinct v, w, hence d >= m",
    "therefore d = m",
]


def variant(line: int, text: str) -> list[str]:
    out = GOOD.copy()
    out[line - 1] = text
    return out


# (name, lines, expected first_error)
CASES = [
    ("correct proof", GOOD, None),
    ("false identity: d = sum of weights", variant(5, "for distinct v, w in C: d(v, w) = wt(v) + wt(w)"), 5),
    ("wrong bound direction", variant(4, "so d <= wt(u) for every nonzero u, hence d >= m"), 4),
    ("denies 0 in C", variant(3, "C linear, so 0 is not in C"), 3),
    ("claims v + w = 0 for distinct v, w", variant(6, "C linear, so v + w = 0 for distinct v, w"), 6),
    ("non-sequitur conclusion", variant(8, "therefore d > m"), 8),
]


def check(lines: list[str]) -> dict:
    body = json.dumps({
        "problem": PROBLEM,
        "image": TINY_PNG,
        "lines": list(range(1, len(lines) + 1)),
        "transcript": {str(i + 1): t for i, t in enumerate(lines)},
    }).encode()
    req = urllib.request.Request(f"{URL}/api/check", data=body, headers={
        "content-type": "application/json",
        # Cloudflare's bot filter dislikes the default urllib agent.
        "user-agent": "Mozilla/5.0 (eval) AppleWebKit/605.1.15 Safari/604.1",
    })
    return json.loads(urllib.request.urlopen(req, timeout=240).read())


def main() -> int:
    failures = 0
    for name, lines, expected in CASES:
        out = check(lines)
        got = out["first_error"]
        skipped = [l["line"] for l in out["lines"] if l["status"] == "skip"]
        ok = got == expected and not skipped
        failures += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {name}: first_error={got} (want {expected})"
              + (f", skipped={skipped}" if skipped else ""))
        if got is not None and out["hints"]:
            print(f"      hint: {out['hints'][0][:100]}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} cases passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
