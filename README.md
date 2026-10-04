<img width="2172" height="724" alt="EED5AB45-0FA7-475D-87C9-C79B46261CC8" src="https://github.com/user-attachments/assets/257002b2-9887-40da-baff-aae21b1c7586" />

[▶️ Watch the Untangled Demo on YouTube](https://youtu.be/56DcrK1BDGQ)

### A GPS for solving math. You do the driving.

Untangled is an AI tutor that **navigates your reasoning as you solve**.

Work naturally on a digital whiteboard. Untangled follows your work line by line and verifies your reasoning in the background. When you take a wrong turn, it marks the exact step, says **"Recalculating,"** and gives you progressively stronger hints to help you find your own way back.

It doesn't hand you the destination. **It gives you turn-by-turn guidance.**

---

## The Problem

You make a mistake on **line 2**.

You realize it on **line 12**.

Most AI study tools either give you the entire solution or force you into a loop of:

> photo → upload → wait → answer → repeat

But when you're solving a problem, you don't need someone to hand you the destination.

You need to know **the moment you take a wrong turn.**

---

## How Untangled Works

A GPS doesn't drive the car for you. It watches your route, stays quiet while you're on track, and speaks up when you miss a turn.

**Untangled does the same for math.**

```text
You write
   ↓
Vision model reads your handwriting
   ↓
SymPy verifies the math
   ↓
Wrong turn?
   ↓
📍 Mark the exact line
🔊 "Recalculating."
💡 Give a hint
   ↓
✓ Back on route
```

Untangled separates **reading** from **checking**. A vision-capable model converts handwritten work into structured math, while SymPy verifies supported transformations symbolically. If a step can't be verified symbolically, Untangled can fall back to an AI judgment and labels it accordingly.

The result: **Ink → Model → Algebra → Pedagogy.**

---

## Features

### 📍 First Wrong-Turn Detection
Untangled identifies the **first line where your reasoning breaks**, rather than flagging every later step caused by the same mistake.

### 💡 Progressive Hint Ladder
Instead of revealing the solution immediately:

**Nudge → Direction → Correction**

You choose how much help you need.

### 🔊 GPS-Style Voice
Untangled stays quiet when you're on track.

> **"Recalculating."** — wrong turn  
> **"Back on route."** — corrected  
> **"You have arrived."** — solved

### ✍️ Live Whiteboard
Solve naturally using a **stylus, touch, mouse, or keyboard**. Untangled checks completed lines and pauses so feedback can arrive while you're still working.

### 📷 Homework Scanner
Import a photo or PDF, select a problem, and turn it into your **destination**.

### 💬 Ask Untangled
Ask questions by voice or keyboard. Untangled uses your current board and verification context to answer without immediately giving away the solution.

### 🌎 Multilingual
Guidance is available in **English, Spanish, French, Chinese, Hindi, and Bengali.**

---

## Tech Stack

**Frontend:** React 19 · TypeScript · Vite · perfect-freehand · KaTeX · PDF.js

**Backend:** Python · FastAPI · Pydantic · SymPy

**AI:** Claude · Gemini · Grok · ElevenLabs

We deliberately split the system into two jobs:

- **AI reads** messy handwriting and provides tutoring.
- **SymPy verifies** the mathematics whenever possible.

This reduces hallucinations while keeping the system flexible enough to understand real handwritten work.

---

## Run It Yourself

### Prerequisites

- Python 3.11+
- `uv`
- Node.js 20+
- API key for a supported model provider

### 1. Clone

```bash
git clone https://github.com/wasihussain914/northstar.git
cd northstar
```

### 2. Configure

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Add your provider key to `backend/.env`.

For Claude:

```env
ANTHROPIC_API_KEY=your_key_here
```

Claude is the default provider. Gemini and Grok are also supported.

For local development, leave `VITE_BACKEND_IP` unset.

### 3. Run

```bash
./dev.sh
```

Or start each service separately:

**Backend**

```bash
cd backend
uv sync
uv run uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

**Frontend**

```bash
cd frontend
npm ci
npm run dev
```

Then open the URL printed by Vite, usually:

```text
http://localhost:5173
```

For phone/iPad setup on the same Wi-Fi, see `IPAD.md`.

---

## How It Works

Untangled deliberately separates **reading the math** from **checking the math**.

```text
your handwriting
      │
      ▼
┌──────────────────┐
│  Vision Model    │
│                  │
│ ink → structured │
│ math expression  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│      SymPy       │
│                  │
│ verify reasoning │
│ between steps    │
└────────┬─────────┘
         │
    wrong turn?
         │
         ▼
┌──────────────────┐
│   AI Tutor       │
│                  │
│ generate a hint  │
│ for that step    │
└────────┬─────────┘
         │
         ▼
   📍 exact line
   🔊 GPS feedback
   💡 hint ladder

**A GPS for solving math. You do the driving.**


