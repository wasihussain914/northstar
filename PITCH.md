# North Star: pitch & demo script

## One-liner
**North Star is a GPS for solving math.** It watches you work on a whiteboard and, like a GPS, says *"Recalculating"* the
moment you take a wrong turn. It never drives for you.

## The problem (20s)
You're halfway through a problem and something's off. Getting help today means copying your messy work into a chat,
explaining where you are, and usually getting the whole solution back. That's like asking for directions and being
teleported to the destination: you arrive, but you never learn the route.

## The theme fit (Navigation)
| GPS | North Star |
|---|---|
| Knows where you are without you saying | Reads your board live, with no copy-paste |
| "Recalculating…" when you miss a turn | Pins the exact line where the math went wrong, says it out loud |
| Doesn't stop you, re-routes you | Graduated hints: where to look → which rule → the fixed line, never the final answer |
| Shows the route and ETA | Route panel: each step as a stop, an estimate of how many steps remain, shortcuts spotted |
| "You have arrived" | Trip summary: steps, wrong turns caught, hints used, time |

| Enter a destination | Photograph your homework; the problem Claude reads becomes the destination card |
| A route with multiple stops | Scan a worksheet: every problem is a stop, with itinerary dots and "Next stop · 2 of 4" |
| Guidance in your language | Hints and the voice itself in English, Español, Français, 中文, हिन्दी, বাংলা |

Tracks: **Wayfinding** (navigating a solution space) and **Accessibility** (a voice-first tutor in six languages, for anyone
without a tutor at their kitchen table — "regardless of language", as the prompt says).

Opening line, stolen from the theme announcement itself: *"Before Google Maps, we navigated by the stars."* That's the name.

## Demo (2 min)
1. **Set up (10s).** Tap **Scan homework**, photograph the worksheet, box problem 3 — it becomes the destination,
   pinned above the paper as a crop of the actual homework. (Fallback: pick the preset chip.)
2. **Wrong turn (30s).** Write `2x − 6 + 4 = 10`, then deliberately `2x + 2 = 10`, then keep going: `2x = 8`.
   → Line 2 gets an amber pin, the route turns dashed, and the voice says *"Recalculating…"*. Point out that line 3 is still
   green: North Star knows it correctly follows from the mistake. **Only the wrong turn is flagged.**
3. **Hint ladder (20s).** Tap "Give me a hint" once. It points at where to look, not the answer.
4. **Ask by voice (15s).** Tap the mic: "Why is line 2 wrong?" It answers out loud in plain words.
5. **Fix it (25s).** Erase and rewrite line 2. North Star notices line 3 now needs updating. Fix it, write `x = 6`.
   → *"You have arrived."* Trip summary appears — with **Next stop · 2 of 2** if you scanned the whole worksheet.
   If there's time: flip the language picker to Español and ask "why was line 2 wrong?" — the answer comes back
   spoken in Spanish.
6. **How it works (20s).** "Claude reads the handwriting. **SymPy proves** each step, so a green check marked 'verified'
   means mathematically equivalent, not just 'looks right' to an AI."

Backup: if the iPad or Wi-Fi misbehaves, hit **▶ Demo** to replay the same solve in animated handwriting.

## Technical highlights (for judges who ask)
- **Claude reads, SymPy proves.** Claude Sonnet 5.5 (vision) transcribes each labeled line into LaTeX and SymPy syntax and
  writes the hints. SymPy then checks each step against the one before it, comparing solution sets for equations and
  inequalities and testing equality for expressions. That catches sign errors, flipped inequalities, lost roots, and steps that
  add extra solutions (flagged as a caution). Steps SymPy can't decide fall back to Claude and are labeled "AI-checked".
- **No answer leaks.** SymPy's internal details (which contain solution values) only go to Claude, which is told never to
  reveal them; students see a safe note. A test guards this.
- **Safe parsing.** Claude's transcriptions are untrusted input to a parser that uses `eval`, so we whitelist characters
  and identifiers first. SymPy runs in worker processes that are killed if a step takes too long.
- **The board is the interface.** Ruled lines give every step a stable number, so markers, voice and hints can all say
  "line 3". Snapshots are cropped to the written area with a blue line label in the margin.
- **The voice policy is GPS-like.** It stays quiet while you write. It speaks when you've written past a wrong line, or after
  7 seconds idle on it, and says "Back on route" when you fix it.

## What's next
Camera mode for physical whiteboards, calculus (derivative steps checked with SymPy too), classroom view for teachers
(where does the class go off route most?).
