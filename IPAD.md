# Run Untangled on an iPad

The iPad does not get a copy of this repo. It is the screen and the pencil. Your Windows PC stays the server: it runs the web app and the API, and it is the only machine that holds the API key.

Safari on the iPad loads the page from the PC. Board checks go to the API on this PC at port 8000. Set `VITE_BACKEND_IP` in `frontend/.env` and `LOCAL_IP` in `backend/.env` to the PC's LAN IPv4 so the iPad does not try `localhost` (which would mean the iPad itself). Leave both unset when you only use the app on the PC.

```
iPad Safari  --Wi-Fi-->  PC :5173 (Vite, npm run dev)
                 \
                  \  /api  (http://<LOCAL_IP>:8000)
                   v
                PC :8000 (FastAPI + SymPy + Claude/Gemini)
```

## What to use when

| Situation | Do this |
|---|---|
| iPad and PC on the same Wi-Fi, devices can see each other | [Same network](#1-same-network-use-this-first) |
| Venue Wi-Fi isolates clients (common on guest and campus Wi-Fi) | [Phone hotspot](#2-phone-hotspot) |
| iPad is on cellular, or you are not next to the PC | [Tunnel](#3-tunnel-when-you-are-not-on-the-same-network) |
| You want the mic (“Ask Untangled” by voice) | Tunnel. iOS only allows speech recognition on HTTPS. Drawing, typed steps, checks, and the GPS voice work on plain `http://` |

Putting the Python or Node project on the iPad (Files, Working Copy, a-Shell, iSH) does not run this app. The API needs Python, uv, SymPy, and your key. Leave that on the PC.

---

## 1. Same network (use this first)

### On the PC, once

1. Install Python 3.11+, [uv](https://docs.astral.sh/uv/), and Node 20+.
2. In `backend/`, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`. For iPad/phone testing, also set `LOCAL_IP` to this PC's LAN IPv4.
3. In `frontend/`, copy `.env.example` to `.env` and set `VITE_BACKEND_IP` to that same IPv4. Run `npm install` once.

### On the PC, every time you demo

Open two PowerShell windows in this repo.

Window 1, the API (listen on the LAN so the iPad can reach port 8000):

```powershell
cd backend
uv run uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Window 2, the web app (this is what the iPad opens). `npm run dev` already passes `--host`, so Vite listens on your LAN address and prints a `Network:` URL:

```powershell
cd frontend
npm run dev
```

Vite looks like this:

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.42:5173/
```

Use the **Network** line. `localhost` on the iPad means the iPad itself, not your PC.

If you use Git Bash, `./dev.sh` starts both. It will not work in PowerShell.

If Windows Firewall asks, allow **Node** and **Python** on **Private** networks. If no prompt appears and the iPad cannot connect, allow ports 5173 and 8000 on private networks only:

```powershell
New-NetFirewallRule -DisplayName "Untangled Vite" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "Untangled API" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Private
```

Leave the PC awake and both windows running. A sleep or a closed terminal drops the iPad.

### On the iPad

1. Join the **same Wi-Fi** as the PC. Turn off VPN and iCloud Private Relay for the test if the page will not load.
2. Open **Safari** (not an in-app browser).
3. Go to the Network URL, for example `http://192.168.1.42:5173`.
4. Optional: Share → **Add to Home Screen**. That is a bookmark. It still needs the PC to be running.

Confirm it is really talking to your server: the app should leave its “can’t reach the server” state, and writing a line (or tapping **▶ Demo**) should come back with route markers. On the PC, the API window should log `POST /api/check`.

If Safari says it cannot connect:

- PC and iPad must be on the same band of the same network (not “Guest”).
- Re-check the IPv4 address with `ipconfig`. Use the Wi-Fi adapter, not a virtual adapter (`172.*` from WSL or Hyper-V, or `100.*` from Tailscale, unless you meant to use that).
- Run the servers on Windows itself. A server started inside WSL is often unreachable from the iPad.

---

## 2. Phone hotspot

Guest and campus Wi-Fi often block phone-to-laptop traffic even when both show as connected. Then the Network URL will time out and nothing is wrong with the app.

Turn on your phone’s hotspot. Join it from **both** the PC and the iPad. Start the two servers again (the Network IP will change). Open the new `http://…:5173` URL in Safari.

---

## 3. Tunnel (when you are not on the same network)

A tunnel publishes the Vite port on a public HTTPS address. The API and the key stay on the PC. The iPad only needs that HTTPS link, including on cellular.

Anyone who has the link can use your API quota until you stop the tunnel. Stop it when you are done. Do not put the URL in git.

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (no account for a quick link):

```powershell
cloudflared tunnel --url http://127.0.0.1:5173
```

Or [ngrok](https://ngrok.com/):

```powershell
ngrok http 5173
```

Start the API and `npm run dev` first, then the tunnel. On the iPad, open the `https://….trycloudflare.com` or `https://….ngrok…` URL in Safari.

A public tunnel to **5173** is not enough by itself: the page calls the API at `http://<VITE_BACKEND_IP>:8000`. Same-network testing should set that IP (and `LOCAL_IP` on the API). Tunneling only the API leaves the iPad with nothing to draw on.

HTTPS is what unlocks the microphone for Ask Untangled. Spoken GPS replies (`speechSynthesis`) already work on the plain LAN `http://` URL.

Tailscale is the private version of the same idea: install it on the PC and the iPad, then open `http://<tailscale-ip>:5173`. No public link, and the mic still needs a real HTTPS URL if you care about voice input.

---

## On the iPad, once the page is open

- Apple Pencil uses real pressure. The canvas keeps the pen pointer and drops the palm. A wide touch is ignored, and if your palm lands first that mark is discarded when the pencil touches. After the pencil has been used, fingers stay ignored.
- The type bar at the bottom adds a step as exact text (no handwriting to misread). Pick a line in the route list to replace it.
- **▶ Demo** plays a scripted solve if the pencil or the network misbehaves. Touching the board stops it.
- Keyboard shortcuts (`P`, `E`, undo) are for a hardware keyboard. On the tablet, use the on-screen pen, eraser, undo, and type bar.
- Add to Home Screen only after you know which URL you will keep using. A LAN bookmark breaks when your PC’s IP changes; a tunnel bookmark dies when you stop the tunnel.

---

## Before you leave the laptop

- [ ] `backend/.env` has a key (or you started the API with `NORTHSTAR_FAKE_VISION=1`, which cannot read handwriting).
- [ ] API window is up on port 8000.
- [ ] Vite window is up and you copied the **Network** URL (or the tunnel HTTPS URL).
- [ ] iPad Safari opened that URL and a check shows up in the API log.
- [ ] PC will not sleep during the demo.
