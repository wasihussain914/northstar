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
    problem: "Solve 2(x − 3) + 4 = 10",
    steps: [
      { do: "write", line: 1, text: "2x - 6 + 4 = 10" },
      { do: "write", line: 2, text: "2x + 2 = 10" }, // the wrong turn: -6 + 4 is -2
      { do: "write", line: 3, text: "2x = 8" },
      { do: "until", what: "error" },
      { do: "pause", ms: 4500 },
      { do: "erase", line: 2 },
      { do: "write", line: 2, text: "2x - 2 = 10" },
      { do: "pause", ms: 600 },
      { do: "erase", line: 3 },
      { do: "write", line: 3, text: "2x = 12" },
      { do: "write", line: 4, text: "x = 6" },
      { do: "until", what: "arrived" },
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
}

const WRITE_MS = 1100; // time to "write" one line
const UNTIL_TIMEOUT_MS = 30000;

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
        const strokes = textToStrokes(step.text, step.line).sort((a, b) => a.box.minX - b.box.minX);
        const chunks = 14;
        const per = Math.ceil(strokes.length / chunks);
        for (let i = 0; i < strokes.length; i += per) {
          hooks.add(strokes.slice(i, i + per));
          await sleep(WRITE_MS / chunks);
        }
        await sleep(350);
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
