import { LINE_H, lineOf, makeStroke, type Stroke } from "./geometry";

/** The text each helper-written line was made from (tagged on its first stroke). */
const typed = new WeakMap<Stroke, string>();

/** line -> text, for lines written with the helper that are still on the board. */
export function typedTranscript(strokes: Stroke[]): Record<number, string> | undefined {
  const out: Record<number, string> = {};
  for (const s of strokes) {
    const text = typed.get(s);
    if (text) out[lineOf(s)] = text;
  }
  return Object.keys(out).length ? out : undefined;
}

const FONT = '46px "Bradley Hand", "Noteworthy", "Chalkboard SE", "Comic Sans MS", cursive';

/**
 * Turn typed text into ink strokes on a ruled line, in a handwriting font.
 * Used for typed steps (no stylus needed) and the demo autopilot. The text is
 * remembered so the server gets it verbatim instead of reading it back.
 */
export function textToStrokes(text: string, line: number, x0 = 28): Stroke[] {
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = FONT;
  const w = Math.ceil(probe.measureText(text).width) + 8;
  const h = LINE_H;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.font = FONT;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#000";
  ctx.fillText(text, 2, Math.round(h * 0.66));
  const { data } = ctx.getImageData(0, 0, w, h);

  // Fill the glyphs with short horizontal strokes, one per scan row.
  const top = (line - 1) * LINE_H;
  const strokes: Stroke[] = [];
  for (let y = 0; y < h; y += 2) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && data[(y * w + x) * 4 + 3] > 110;
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        strokes.push(makeStroke([[x0 + start, top + y, 0.5], [x0 + x - 1, top + y, 0.5]], true));
        start = -1;
      }
    }
  }
  if (strokes.length) typed.set(strokes[0], text);
  return strokes;
}
