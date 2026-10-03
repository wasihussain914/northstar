# ✦ North Star

**A GPS for solving math.** Work a problem on a digital whiteboard and North Star follows along. It never solves
the problem for you. When you take a wrong turn it marks the exact line, says *"Recalculating"* out loud, and
gives you hints that get more specific each time you ask.

Built for Cornell Hacks 2026 (theme: **Navigation**).

## How it works

```
 you write ──▶ pause ~1.2s ──▶ board snapshot (lines labeled 1, 2, 3…)
                                   │
                                   ▼
                     Claude Sonnet 5.5 (vision) reads each line 
                     → LaTeX + SymPy syntax
                                   │
                                   ▼
                     SymPy checks each step against the one before
                     (equivalent? lost a root? flipped inequality?)
                                   │
                     wrong turn? → a second, smaller Claude call
                                   writes the hint ladder
                                   ▼
          gutter markers ✓ 📍 ⚠ · route panel · GPS voice · hint ladder
```

- **Claude reads, SymPy proves.** Claude transcribes the handwriting; when a step is wrong, a second, smaller
  Claude call writes the hints. Whether a step is
  correct is decided by SymPy where it can: for equations it compares solution sets, for expressions it checks
  that they're equal. Steps SymPy can't decide fall back to Claude's judgment and are labeled "AI-checked"
  instead of "verified".
- **First wrong turn, not every wrong line.** A line that correctly carries an earlier mistake forward is still
  on route. Only the line where the mistake was made gets the 📍.
- **The voice speaks up like a GPS.** It stays quiet while you work. It speaks once you've written past the
  wrong line (you "missed the turn"), or after you've been idle on it for 7 seconds. It also says "Back on route"
  and "You have arrived."
- **Hint ladder:** a nudge toward where to look → the rule that was misapplied → the corrected line. It never
  gives the final answer.

Also:
- **Ask North Star.** Tap the mic (or type) to ask "why is line 2 wrong?". Claude sees the board and the last
  check, and answers out loud in at most three sentences, never with the final answer.
- **Trip summary** on arrival: steps, wrong turns (stale lines after a fix don't count), hints used, time.
- **▶ Demo** plays a scripted solve in animated handwriting: a deliberate mistake, the catch, the fix, the arrival.
  Use it to present without a stylus. Touching the board stops it.
- **Any screen size.** Narrow screens show the board scaled down instead of cutting lines off.
- **Type a step** (`T`) for anyone who can't or would rather not use a pen. The line appears on the board in
  handwriting, and the server gets the exact text, so nothing is lost in reading it back. Select a line in the
  route list to replace it.
- **Read aloud** turns your whole route into spoken math ("Line 2, wrong turn: two x plus two equals ten").

## Run it

You'll need Python 3.11+, [uv](https://docs.astral.sh/uv/), Node 20+, and an Anthropic API key.

```bash
cp backend/.env.example backend/.env   # then put your key in backend/.env
./dev.sh                               # API on :8000, app on :5173
```

Open http://localhost:5173. **On an iPad:** connect it to the same Wi-Fi and open the `Network:` URL that Vite
prints. The Apple Pencil gets real pressure, and fingers are ignored once you've used the pencil (palm rejection).

Shortcuts: `P` pen, `E` eraser, `⌘Z` / `⇧⌘Z` undo/redo. Right-click drag also erases.

## Tests

```bash
cd backend && uv run pytest
```

**Without an API key:** start the API with `NORTHSTAR_FAKE_VISION=1`. Instead of sending the image to Claude, the server
uses the text typed by the dev helper below. SymPy, markers, voice, hints and the route panel all run for real, but hints
are plain templates. Hand-drawn strokes can't be read in this mode.

## Layout

| Path | What |
|---|---|
| `backend/verify.py` | SymPy step checker (sanitized parsing, equivalence, lost/extra solutions) |
| `backend/tutor.py` | Claude calls: read the board, explain a SymPy-flagged line |
| `backend/main.py` | FastAPI: `/api/check` merges both; SymPy runs in killable worker processes |
| `frontend/src/board/` | Ruled whiteboard canvas, stroke → line mapping, the labeled snapshot sent to Claude |
| `frontend/src/useTutor.ts` | Pause detection, request handling, the voice policy |
| `frontend/src/RoutePanel.tsx` | Status, hint ladder, route view |

Dev helper (in the browser console while running `npm run dev`):
`northstar.write(1, "2x - 6 + 4 = 10")` writes a line in a handwriting font.
