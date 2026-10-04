<img width="2172" height="724" alt="EED5AB45-0FA7-475D-87C9-C79B46261CC8" src="https://github.com/user-attachments/assets/257002b2-9887-40da-baff-aae21b1c7586" />

### A GPS for solving math. You do the driving.

Untangled is a personalized AI tutor that navigates your reasoning as you solve.

Work naturally on a digital whiteboard. Untangled follows your work line by line, verifies your reasoning in the background, and stays quiet while you're on track. The moment you take a wrong turn, it marks the exact step, says **"Recalculating,"** and gives you progressively stronger hints to help you find your own way back.

It doesn't hand you the destination. It gives you turn-by-turn guidance.

**Built for Cornell Hacks 2026 — Theme: Navigation.**

---

## The Problem

You make a mistake on **line 2**.

You realize it on **line 12**.

The expensive part isn't the mistake — it's everything you do before realizing where you went wrong.

Most AI study tools don't solve this problem. They turn learning into a back-and-forth chat:

**take a photo → upload → wait → get an answer → repeat**

Or they simply generate the entire solution.

But when you're actually solving a problem, what you need isn't someone to hand you the destination. You need to know **when you took a wrong turn.**

That's what Untangled is built for.

---

## The Idea: Turn-by-Turn for Your Thinking

A GPS doesn't drive the car for you.

It watches your route, stays quiet while you're going the right way, and speaks up when you miss a turn.

**Untangled does the same thing for math.**

You solve the problem yourself. Untangled follows along in the background.

When your reasoning is valid:

> ✓ On route.

When a step breaks:

> 📍 Wrong turn — Line 3  
> 🔊 "Recalculating."

And once you've corrected it:

> ✓ Back on route.

The goal isn't to get you to the answer as quickly as possible.

The goal is to help you understand **how to get there yourself.**

---

## What Untangled Does

### ✍️ Follows your work as you write

Solve naturally with a stylus, mouse, touch, or keyboard.

Untangled groups your writing into lines and creates checkpoints as you work. Starting a new line triggers a check of the line you just completed, while a short pause checks the current board.

That means feedback arrives **during the solving process**, not after you've already finished.

### 📍 Finds the first wrong turn

Untangled doesn't mark every line downstream of a mistake as wrong.

It identifies the moment your reasoning first went off route.

If line 3 contains the actual mistake and lines 4–6 correctly continue from that mistaken assumption, **line 3 is the wrong turn.**

That's the line Untangled points you back to.

### 🧭 Guides instead of solving

Untangled doesn't immediately reveal the answer.

Hints form a ladder:

1. **Nudge** — points you toward where to look
2. **Direction** — reminds you of the relevant rule or idea
3. **Correction** — shows how that specific step should change

You climb only as far as you need.

The final destination is still yours to reach.

### 🔊 Speaks like a GPS

Untangled intentionally stays quiet while you're solving correctly.

When you miss a turn, it can speak:

> "Recalculating."

Fix your reasoning:

> "Back on route."

Finish the problem:

> "You have arrived."

The voice isn't constant narration. It follows a **navigation policy** designed to intervene only when useful.

### 💬 Ask Untangled

Need clarification?

Ask by microphone or keyboard:

> "Why is line 2 wrong?"

Untangled sees your current whiteboard and the most recent verification result, so its response is grounded in what you're actually doing.

Responses stay concise and avoid giving away the final answer.

### 📷 Turn homework into a route

Import a photo or PDF of your homework and drag a box around the problem you want to solve.

Untangled reads it and turns it into your **destination**.

Scan an entire worksheet and each problem can become another stop on the trip.

### 🌎 Navigate in your language

Guidance is available in six interface/guidance languages:

- English
- Español
- Français
- 中文
- हिन्दी
- বাংলা

Hints, spoken feedback, encouragement, and Ask Untangled responses change language while the underlying mathematics stays the same.

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
