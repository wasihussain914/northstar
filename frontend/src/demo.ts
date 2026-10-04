import { textToStrokes } from "./board/handwriting";
import type { Stroke } from "./board/geometry";

/**
 * Demo autopilot: writes a solve in animated "handwriting", takes a wrong turn
 * on purpose, waits for Untangled to catch it, then fixes it and finishes.
 * For presenting without a stylus.
 */

export type DemoStep =
  | { do: "write"; line: number; text: string }
  | { do: "erase"; line: number }
  | { do: "pause"; ms: number }
  | { do: "until"; what: "error" | "on-route" | "arrived" };

export interface DemoScript {
  problem: string;
  steps: DemoStep[];
}

export const DEMOS: DemoScript[] = [
  {
    // The lost root: dividing by x looks fine and silently throws away x = 0.
    // SymPy compares solution sets, so the sin is caught, proven.
    problem: "Solve x² = 5x",
    steps: [
      { do: "write", line: 1, text: "x^2 = 5x" },
      { do: "write", line: 2, text: "x = 5" }, // divided both sides by x
      { do: "until", what: "error" },
      { do: "pause", ms: 5000 },
      { do: "erase", line: 2 },
      { do: "write", line: 2, text: "x^2 - 5x = 0" },
      { do: "pause", ms: 600 },
      { do: "write", line: 3, text: "x(x - 5) = 0" },
      { do: "write", line: 4, text: "x = 0 or x = 5" },
      { do: "until", what: "arrived" },
    ],
  },
  {
    // Study-guide problem 4 (MATH 3320): a proof, with the classic wrong
    // identity planted — distance is the weight of the SUM, not the sum of
    // the weights. Claims are judged by the model, so this demo shows proof
    // tutoring, not just algebra.
    problem: "Prove: the distance of a linear code C equals the minimum weight of its nonzero codewords",
    steps: [
      { do: "write", line: 1, text: "m = min wt(u), u != 0" },
      { do: "write", line: 2, text: "d(u, 0) = wt(u)" },
      { do: "write", line: 3, text: "0 in C, so d <= m" },
      { do: "write", line: 4, text: "d(v, w) = wt(v) + wt(w)" }, // the wrong turn
      { do: "until", what: "error" },
      { do: "pause", ms: 5000 },
      { do: "erase", line: 4 },
      { do: "write", line: 4, text: "d(v, w) = wt(v + w)" },
      { do: "pause", ms: 600 },
      { do: "write", line: 5, text: "v + w in C, v + w != 0" },
      { do: "write", line: 6, text: "so d >= m, hence d = m" },
      { do: "until", what: "on-route" },
    ],
  },
  {
    problem: "Differentiate x³ − 3x² + 2x",
    steps: [
      { do: "write", line: 1, text: "3x^2 - 6x" }, // the wrong turn: dropped the + 2
      { do: "until", what: "error" },
      { do: "pause", ms: 4000 },
      { do: "erase", line: 1 },
      { do: "write", line: 1, text: "3x^2 - 6x + 2" },
      { do: "until", what: "arrived" },
    ],
  },
  {
    problem: "Solve −2x + 4 > 10",
    steps: [
      { do: "write", line: 1, text: "-2x > 6" },
      { do: "write", line: 2, text: "x > -3" }, // forgot to flip the inequality
      { do: "until", what: "error" },
      { do: "pause", ms: 4500 },
      { do: "erase", line: 2 },
      { do: "write", line: 2, text: "x < -3" },
      { do: "until", what: "arrived" },
    ],
  },
];

export interface DemoHooks {
  setProblem: (p: string) => void;
  clear: () => void;
  add: (strokes: Stroke[]) => void;
  eraseLine: (line: number) => void;
  /** Current tutor state, read fresh each poll. */
  state: () => { errorLine: number | null; arrived: boolean; ready: boolean };
  /** How to turn a line of text into ink (the loaded handwriting, or the font). */
  strokesFor?: (text: string, line: number) => Stroke[];
  /** Pause the tutor's checking while a line is mid-write, so it reads whole lines. */
  hold?: (on: boolean) => void;
}

const WRITE_MS = 1100; // time to "write" one line
const UNTIL_TIMEOUT_MS = 30000;

type Sleep = (ms: number) => Promise<void>;

/** Reveal a line left to right in chunks so it looks written. */
async function writeLine(text: string, line: number, hooks: DemoHooks, sleep: Sleep) {
  const make = hooks.strokesFor ?? ((t: string, l: number) => textToStrokes(t, l));
  // Keep the first stroke first: it carries the typed-text tag the server reads.
  const [first, ...rest] = make(text, line);
  if (!first) return;
  const strokes = [first, ...rest.sort((a, b) => a.box.minX - b.box.minX)];
  const chunks = 14;
  const per = Math.ceil(strokes.length / chunks);
  hooks.hold?.(true);
  try {
    for (let i = 0; i < strokes.length; i += per) {
      hooks.add(strokes.slice(i, i + per));
      await sleep(WRITE_MS / chunks);
    }
  } finally {
    hooks.hold?.(false);
  }
  await sleep(350);
}

/**
 * Write several lines one after another, the way the tutor finishes a solve.
 * Resolves when done; rejects with AbortError if the student takes over.
 */
export async function writeLines(lines: { line: number; text: string }[], hooks: Pick<DemoHooks, "add" | "strokesFor" | "hold">, signal: AbortSignal) {
  const sleep: Sleep = (ms) =>
    new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        window.clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  for (const l of lines) {
    if (signal.aborted) return;
    await writeLine(l.text, l.line, hooks as DemoHooks, sleep);
  }
}

export async function runDemo(script: DemoScript, hooks: DemoHooks, signal: AbortSignal) {
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        window.clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });

  hooks.setProblem(script.problem);
  hooks.clear();
  await sleep(700);

  for (const step of script.steps) {
    if (signal.aborted) return;
    switch (step.do) {
      case "write": {
        // Reveal the line left to right in chunks so it looks written.
        await writeLine(step.text, step.line, hooks, sleep);
        break;
      }
      case "erase":
        hooks.eraseLine(step.line);
        await sleep(450);
        break;
      case "pause":
        await sleep(step.ms);
        break;
      case "until": {
        const started = Date.now();
        while (Date.now() - started < UNTIL_TIMEOUT_MS) {
          const s = hooks.state();
          const done =
            step.what === "error" ? s.errorLine != null
            : step.what === "arrived" ? s.arrived
            : s.ready && s.errorLine == null;
          if (done) break;
          await sleep(250);
        }
        break;
      }
    }
  }
}
