# Untangled — Slide Deck

Pitch: you find out you're wrong **when it happens**, not 20 minutes later.
One slide = one idea. Talking points under each slide are for the speaker, not the slide.

---

## Slide 1 — Title

**Untangled**
*A GPS for solving math.*

(Logo, the tangled-line mark, one screenshot of ink on the page. Nothing else.)

> Say: "Everyone here has lost 40 minutes to a minus sign. We fixed that."

---

## Slide 2 — The Problem: the invisible wrong turn

**You make a mistake on line 2. You find out on line 12.**

- You're doing homework. Somewhere early — a dropped negative, a lost root, a bad `du` — you take a wrong turn.
- Nothing tells you. You keep driving. Every line after it is wasted work.
- You find out at the end: answer doesn't match, and now you're re-checking **twelve lines at midnight** to find one bad step.

> Say: the cost of a math mistake isn't the mistake — it's every minute you spend not knowing about it.

---

## Slide 3 — Why today's tools don't fix this

**ChatGPT gives you the destination. You needed the turn-by-turn.**

- Photo → upload → "here's the full solution." You copied it; you learned nothing.
- The back-and-forth is miserable: re-photograph, re-paste, re-explain where you are *every single step*.
- It happily solves the problem **for** you — which is exactly the thing that doesn't make you better at math.

> Say: existing AI tutoring is a vending machine for answers. Homework is supposed to be practice.

---

## Slide 4 — The idea

**A GPS watches you drive. It only speaks when you leave the route.**

- You write on the iPad like normal paper — pen-first, no typing, no photos.
- Untangled reads your handwriting as you go and checks **every step**.
- Wrong turn? *"Recalculating."* — flagged at the exact line, the moment it happens.
- Right route? It stays quiet. You drive.

(Screenshot: the orange "Wrong turn at line 2" with the route panel.)

---

## Slide 5 — LIVE DEMO

**Solve x² = 5x** (the classic lost root) — live, with the pencil, on the real site.

1. Write `x² = 5x` → divide both sides by x → `x = 5`. Instant: *"Recalculating — that step loses a solution."*
2. Ask it out loud: "why is that wrong?" — it answers in voice.
3. Fix it, write `x = 0  x = 5` → **"You have arrived."**

> Backup: proof demo (real MATH 3320 study-guide problem) — it flags the exact false step in a written proof.

---

## Slide 6 — How it works (the part we're proud of)

**Neuro-symbolic: the model reads, the math engine proves.**

- A vision model (Grok) transcribes your handwriting — it *reads*, it doesn't *grade*.
- **SymPy** then mathematically **proves** each step follows from the last. Not an opinion — a proof.
- Two badges in the UI: **verified** (proven) vs **AI-checked** (model judgment). We never lie about which.
- Proof steps in words, substitutions (`u = x²`, `du = 2x dx`), derivatives, inequalities — all covered.

> Say: when Untangled says "you're wrong," it can show you the algebra that proves it. ChatGPT can't.

---

## Slide 7 — It's a tutor, not an answer machine

- **Plan your route**: say your plan out loud before you start; it checks the strategy.
- **Hint ladder**: nudge → rule → fix. You choose how much help you get.
- It writes hints **in handwriting, in red ink, on your page** — like a teacher leaning over.
- **Practice detour**: after a wrong turn, it generates a twin problem so you prove you've got it.
- Ask questions by voice or just *write them on the page* — it answers out loud.

---

## Slide 8 — And your homework is… done

**Solve it once, file it, download the PDF.**

- Every solved problem files into a homework sheet — your name, your course, your handwriting.
- Scan a worksheet photo/PDF in; problems become route stops; export the finished set.
- Speaks 6 languages. Installs like an iPad app.

---

## Slide 9 — Theme: Navigation

**We didn't borrow the metaphor. We built the whole product on it.**

- Destination = the answer. Route = your steps. Wrong turn = your mistake.
- "Recalculating", ETA ("about 4 more steps"), arrival, detours for practice.
- Navigation isn't just maps — it's knowing you're off-course *the moment* it happens.

---

## Slide 10 — Close

**Untangled: never waste another hour on line 2.**

- Live now: northstar.wasihussain.com · open source on GitHub
- Built in 36 hours: 151 backend tests, proof-grade step checking, voice, handwriting in + out.
- Team: [names + roles]

> Say: "Every mistake you make should cost you ten seconds, not an evening. That's Untangled."

---

## Appendix — likely judge questions

- **"What if the model misreads handwriting?"** Transcription is shown live (tap a line); SymPy verdicts are proofs over the transcription. Misreads are visible and correctable — and the typed scratchpad is a fallback.
- **"How is this different from Photomath?"** Photomath solves *their* problem. Untangled checks *your* work. We never produce the answer unless you ask it to finish.
- **"Latency?"** Typed steps: ~0.1s (pure SymPy). Handwriting: ~2.3s — hints load async so "recalculating" is instant.
- **"Does the AI grade the math?"** Only when SymPy can't (prose proof steps) — and the badge says so honestly.
