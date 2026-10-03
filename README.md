# ✦ North Star

**A GPS for solving math.** Work a problem on a digital whiteboard and North Star follows along. It never solves
the problem for you. When you take a wrong turn it marks the exact line, says *"Recalculating"* out loud, and
gives you hints that get more specific each time you ask.

Built for Cornell Hacks 2026 (theme: **Navigation**).

## How it works

```
 📷 scan homework (photo or PDF) ──▶ box the problem ──▶ Claude reads it
                                   │            = your destination
                                   ▼
 you write ──▶ new line? ~0.35s / pause ~1.2s ──▶ board snapshot (lines labeled 1, 2, 3…)
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
  that they're equal (including trig and log identities). The same checker also covers calculus (derivatives,
  integrals, limits, gradients), ODEs and PDEs (by plugging a proposed solution back in), linear algebra
  (determinants, inverses, row reduction), sums, number theory (Euclid, congruences, modular inverses),
  algebraic and induction proofs, the pigeonhole principle, and balancing a chemical equation. Physics that
  is a differential equation, such as constant acceleration, uses the ODE check. Steps SymPy can't decide fall
  back to Claude's judgment and are labeled "AI-checked" instead of "verified".
- **First wrong turn, not every wrong line.** A line that correctly carries an earlier mistake forward is still
  on route. Only the line where the mistake was made gets the 📍.
- **The voice speaks up like a GPS.** It stays quiet while you work. It speaks once you've written past the
  wrong line (you "missed the turn"), or after you've been idle on it for 7 seconds. It also says "Back on route"
  and "You have arrived."
- **Hint ladder:** a nudge toward where to look → the rule that was misapplied → the corrected line. It never
  gives the final answer.

Also:
- **Scan your homework.** Take a photo of the worksheet (or open a photo/PDF), drag a box around the problem
  you're on, and Claude reads it into the destination card — the crop of your actual homework stays pinned above
  the paper while you work. Multi-page PDFs have page arrows; editing the transcription by hand is one tap.
- **Trips with stops.** Scan a whole worksheet and every problem Claude finds becomes a stop on one trip:
  itinerary dots on the destination card, "Next stop · 2 of 4" when you arrive, jump between stops by tapping
  the dots.
- **Six languages.** Pick Español, Français, 中文, हिन्दी or বাংলা and the guidance — hints, spoken nudges,
  encouragement, Ask answers, the GPS voice itself — switches to that language. The math and the checking don't
  change (Accessibility track: navigation "regardless of language").
- **Checkpoints.** The moment you start a new line, the line you just finished is checked (~0.35s), so wrong
  turns surface while your pen is still moving. A ~1.2s pause checks everything else.
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

You'll need Python 3.11+, [uv](https://docs.astral.sh/uv/), Node 20+, and either an Anthropic API key or a Gemini (Google AI) API key.

```bash
cp backend/.env.example backend/.env     # then put your key in backend/.env
cp frontend/.env.example frontend/.env   # leave VITE_BACKEND_IP empty for localhost
./dev.sh                                 # API on :8000, app on :5173
```

On Windows PowerShell, skip `./dev.sh` and start the two processes yourself (see [Phone or iPad](#phone-or-ipad-same-wifi)).

Set `ANTHROPIC_API_KEY` to use Claude, or `GEMINI_API_KEY` to use Gemini. If both keys are set, Claude is used unless `NORTHSTAR_PROVIDER=gemini`.

Open **http://localhost:5173** on this computer. Leave `LOCAL_IP` and `VITE_BACKEND_IP` unset so the app and CORS stay on localhost. That is the teammate default.

Shortcuts: `P` pen, `E` eraser, `⌘Z` / `⇧⌘Z` undo/redo. Right-click drag also erases.

## Phone or iPad (same Wi-Fi)

The phone or iPad is only a browser. This computer still runs the app, the API, and holds the API key.

1. Find this computer's LAN IPv4 (`ipconfig` on Windows, `ip addr` on macOS/Linux). Use the Wi-Fi adapter. Skip virtual adapters (`172.*` from WSL or Hyper-V). Vite also prints it as `Network:` after `npm run dev`.
2. Set **the same IP** in both env files, then restart the API and Vite (Vite only reads `VITE_*` at startup):

```
# backend/.env
LOCAL_IP=192.168.1.42
# FRONTEND_PORT=5173   # optional; this is the default

# frontend/.env
VITE_BACKEND_IP=192.168.1.42
```

The frontend then calls `http://192.168.1.42:8000`. CORS always allows `http://localhost:5173` and `http://127.0.0.1:5173`. With `LOCAL_IP` set, it also allows `http://192.168.1.42:5173`.

3. Start both servers so they listen on the LAN (not only 127.0.0.1):

```powershell
cd backend
uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

```powershell
cd frontend
npm run dev
```

Git Bash or macOS can use `./dev.sh` instead (`--host 0.0.0.0` is already in that script).

Vite prints:

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.42:5173/
```

4. On the phone or iPad, join the **same Wi-Fi** and open the **Network** URL in Safari (or Chrome), for example `http://192.168.1.42:5173`. Do not open `localhost` on the device — that is the device itself. Guest and campus networks often block device-to-device traffic; a phone hotspot with both devices joined works when venue Wi-Fi does not.

If Windows Firewall prompts, allow Node and Python on private networks. If the device cannot connect and no prompt appeared:

```powershell
New-NetFirewallRule -DisplayName "North Star Vite" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "North Star API" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
```

Apple Pencil uses real pressure. The canvas keeps the pen pointer and drops the palm: a wide touch is ignored, and if the palm lands first its mark is discarded when the pencil touches. After the pencil has been used, fingers stay ignored. More iPad notes are in [IPAD.md](IPAD.md).

- Plain `http://` is enough for drawing, typed steps, checks, and the spoken GPS replies. The microphone for Ask North Star needs HTTPS (see ngrok below).
- Keep the computer awake and both processes running.
- A Home Screen icon is only a bookmark; it breaks when this computer's IP changes.
- Run the servers on Windows itself if the tablet is connecting to a Windows PC. A server inside WSL is often unreachable.

## Off-network: ngrok

Use [ngrok](https://ngrok.com/) when the phone is not on the same LAN, or when you need **HTTPS** (iOS only allows the Ask North Star microphone on HTTPS). The API key stays on this computer. Anyone with the public link can use your API quota until you stop ngrok. Do not put the URL in git.

Install ngrok and add your auth token once (`ngrok config add-authtoken …`). Start the API and `npm run dev` on this computer, then in another terminal:

```powershell
ngrok http 5173
```

On the phone or iPad, open the `https://….ngrok-free.app` URL (the **Forwarding** line in the ngrok UI). That is the page only.

Board checks still go to `http://<VITE_BACKEND_IP>:8000`. Tunneling **5173** does not proxy `/api`. For checks from another network you also need the API reachable, for example a second tunnel:

```powershell
ngrok http 8000
```

`VITE_BACKEND_IP` is a LAN IPv4 plus port 8000, not an `https://….ngrok-free.app` host, so same-Wi-Fi `LOCAL_IP` / `VITE_BACKEND_IP` is what makes checks work. ngrok on 5173 is the public HTTPS page (and the mic). Stop both tunnels when you are done.

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
| `backend/tutor.py` | Claude calls: read the board, explain a flagged line, read a scanned problem |
| `backend/main.py` | FastAPI: `/api/check` merges both, `/api/problem` reads a homework crop; SymPy runs in killable worker processes |
| `frontend/src/board/` | Ruled whiteboard canvas, stroke → line mapping, the labeled snapshot sent to Claude |
| `frontend/src/ProblemScanner.tsx` | Photo/PDF import and the crop-the-problem sheet |
| `frontend/src/useTutor.ts` | Checkpoint & pause detection, request handling, the voice policy |
| `frontend/src/RoutePanel.tsx` | Status, hint ladder, route view |

Dev helper (in the browser console while running `npm run dev`):
`northstar.write(1, "2x - 6 + 4 = 10")` writes a line in a handwriting font.
