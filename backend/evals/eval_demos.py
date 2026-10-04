"""Demo reliability eval: every stage demo's wrong turn, graded.

For each demo problem: the sabotaged board must flag EXACTLY the planted
line, and the corrected board must pass clean (no false flags). Run with
a rep count to measure flakiness before going on stage:

    uv run python evals/eval_demos.py 3
"""

from __future__ import annotations

import base64
import json
import os
import struct
import sys
import urllib.request
import zlib

URL = os.environ.get("NORTHSTAR_EVAL_URL", "https://northstar.wasihussain.com").rstrip("/")


def blank_png(width: int = 480, height: int = 240) -> str:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    raw = b"".join(b"\x00" + b"\xff" * (3 * width) for _ in range(height))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    return base64.b64encode(png).decode()


PNG = blank_png()

# (name, problem, wrong board, expected flagged line, corrected board)
DEMOS = [
    ("lost root", "Solve x^2 = 5x",
     ["x^2 = 5x", "x = 5"], 2,
     ["x^2 = 5x", "x^2 - 5x = 0", "x(x - 5) = 0", "x = 0 or x = 5"]),
    ("inequality flip", "Solve -2x + 4 > 10",
     ["-2x > 6", "x > -3"], 2,
     ["-2x > 6", "x < -3"]),
    ("dropped term derivative", "Differentiate x^3 - 3x^2 + 2x",
     ["3x^2 - 6x"], 1,
     ["3x^2 - 6x + 2"]),
    ("proof false identity",
     "Prove: the distance of a linear code C equals the minimum weight of its nonzero codewords",
     ["m = min wt(u), u != 0", "d(u, 0) = wt(u)", "0 in C, so d <= m", "d(v, w) = wt(v) + wt(w)"], 4,
     ["m = min wt(u), u != 0", "d(u, 0) = wt(u)", "0 in C, so d <= m", "d(v, w) = wt(v + w)",
      "v + w in C, v + w != 0", "so d >= m, hence d = m"]),
]


def check(problem: str, lines_text: list[str]) -> dict:
    body = json.dumps({
        "problem": problem,
        "image": PNG,
        "lines": list(range(1, len(lines_text) + 1)),
        "transcript": {str(i + 1): t for i, t in enumerate(lines_text)},
    }).encode()
    req = urllib.request.Request(f"{URL}/api/check", data=body, headers={
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (eval) AppleWebKit/605.1.15 Safari/604.1",
    })
    return json.loads(urllib.request.urlopen(req, timeout=240).read())


def main() -> int:
    reps = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    failures = 0
    for name, problem, wrong, expect, fixed in DEMOS:
        for rep in range(reps):
            got = check(problem, wrong)["first_error"]
            ok_wrong = got == expect
            clean = check(problem, fixed)["first_error"]
            ok_fixed = clean is None
            failures += (not ok_wrong) + (not ok_fixed)
            tag = f"[{rep + 1}/{reps}] " if reps > 1 else ""
            print(f"{tag}{name}: flag={'PASS' if ok_wrong else f'FAIL (got {got}, want {expect})'}"
                  f" | clean={'PASS' if ok_fixed else f'FAIL (flagged {clean})'}")
    total = len(DEMOS) * reps * 2
    print(f"\n{total - failures}/{total} checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
