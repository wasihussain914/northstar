import { layoutText } from "../glyphs/lib/renderText";
import { transformPoint } from "../glyphs/lib/inkMask";
import { makePrng } from "../glyphs/lib/rng";
import type { GlyphLibrary, NormalizedGlyph } from "../glyphs/types/handwriting";
import { LINE_H, makeStroke, strokePath, type Point, type Stroke } from "./geometry";
import { rememberText, textToStrokes } from "./handwriting";

/** Ink height of a written line, in board units. */
const FONT_H = 40;

/**
 * How untidy the writing is, 0 (the dataset's own jitter only) to 1 (a
 * student in a hurry). Adds a wandering baseline, uneven letter size and
 * slant, wobbly strokes with varying pressure, and the odd crossed-out slip.
 */
const MESS = 0.75;

/**
 * The dataset normalises every glyph to full height, so short marks ("=",
 * ".") would be stretched tall. Draw them at their natural size instead:
 * `h` is the height as a fraction of the font height, `mid` where their
 * centre sits above the baseline (also a fraction).
 */
const SMALL: Record<string, { h: number; mid: number }> = {
  "=": { h: 0.26, mid: 0.42 },
  "+": { h: 0.62, mid: 0.42 },
  ".": { h: 0.08, mid: 0.05 },
  ",": { h: 0.22, mid: 0.02 },
  ":": { h: 0.55, mid: 0.35 },
  "×": { h: 0.5, mid: 0.42 },
  "·": { h: 0.08, mid: 0.42 },
  "~": { h: 0.25, mid: 0.45 },
  "<": { h: 0.6, mid: 0.42 },
  ">": { h: 0.6, mid: 0.42 },
  "≤": { h: 0.7, mid: 0.4 },
  "≥": { h: 0.7, mid: 0.4 },
  "±": { h: 0.7, mid: 0.4 },
  "^": { h: 0.3, mid: 0.85 },
  "'": { h: 0.25, mid: 0.85 },
};

/** A stable seed per line so the same text always lays out the same way. */
function seedOf(text: string, line: number): number {
  let h = line * 7919;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** Size and centre for a laid-out glyph, honouring the SMALL table. */
function placement(label: string, scaledHeight: number, baseline: number, verticalOffset: number) {
  const small = SMALL[label];
  if (!small) return { scaled: scaledHeight, cy: baseline + verticalOffset - scaledHeight / 2 };
  return { scaled: scaledHeight * small.h, cy: baseline + verticalOffset - scaledHeight * small.mid };
}

/** The pen's path for one glyph, placed and roughened. */
function glyphInk(
  glyph: NormalizedGlyph, cx: number, cy: number, scaled: number, rot: number,
  rng: () => number, fontH: number,
): Stroke[] {
  const out: Stroke[] = [];
  const amp = 0.5 * MESS * (fontH / 40); // wobble amplitude in board px
  for (const stroke of glyph.strokes) {
    if (!stroke.length) continue;
    const raw = stroke.map((p) => transformPoint(p, glyph, cx, cy, scaled, rot));
    if (raw.length === 1) raw.push({ x: raw[0].x + 0.8, y: raw[0].y + 0.8 });
    // Low-frequency wobble across the stroke, and a pressure that breathes.
    const f1 = 0.08 + rng() * 0.08, f2 = 0.25 + rng() * 0.2;
    const p1 = rng() * 6.28, p2 = rng() * 6.28, p3 = rng() * 6.28;
    const base = 0.42 + rng() * 0.16;
    const pts: Point[] = [];
    let s = 0;
    for (let i = 0; i < raw.length; i++) {
      const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      if (i > 0) s += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
      const n = amp * (Math.sin(s * f1 + p1) + 0.5 * Math.sin(s * f2 + p2));
      const pressure = Math.max(0.25, Math.min(0.85, base + 0.14 * MESS * Math.sin(s * 0.12 + p3) + (rng() - 0.5) * 0.06 * MESS));
      pts.push([raw[i].x + (-dy / len) * n, raw[i].y + (dx / len) * n, pressure]);
    }
    out.push(makeStroke(pts, true));
  }
  return out;
}

/** A quick scribble through a slip, the way you'd cross out a wrong digit. */
function scribble(x0: number, x1: number, yTop: number, yBottom: number, rng: () => number): Stroke {
  const pts: Point[] = [];
  const n = 5 + Math.floor(rng() * 3);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = i % 2 === 0 ? yTop + rng() * 3 : yBottom - rng() * 3;
    pts.push([x0 - 2 + (x1 - x0 + 4) * t + (rng() - 0.5) * 2, y, 0.5 + rng() * 0.2]);
  }
  return makeStroke(pts, true);
}

/**
 * Lay a line of text out in the handwriting and return it as pen strokes,
 * in whatever coordinate space `baseline` is in. The first stroke is kept
 * first so it can carry the typed-text tag.
 */
function inkFor(text: string, library: GlyphLibrary, x0: number, baseline: number, fontH: number, seed: number, line: number): Stroke[] {
  const rng = makePrng(seed);
  const { glyphs } = layoutText(text, library, x0, baseline, { fontHeight: fontH, seed });
  const out: Stroke[] = [];

  // The line as a whole: a slow wander plus a slight tilt.
  const tilt = (rng() - 0.5) * 0.02 * MESS;
  const w1 = 120 + rng() * 120, w2 = 40 + rng() * 50;
  const q1 = rng() * 6.28, q2 = rng() * 6.28;
  const drift = (x: number) => (x - x0) * tilt + MESS * (2.2 * Math.sin((x - x0) / w1 + q1) + 1.2 * Math.sin((x - x0) / w2 + q2));

  // One slip per line, sometimes: a wrong character, crossed out, then the right one.
  const drawable = glyphs.filter((g) => g.type === "glyph" && g.glyph);
  const slipAt = drawable.length >= 4 && rng() < 0.18 * MESS ? drawable[1 + Math.floor(rng() * (drawable.length - 1))] : null;

  let shift = 0; // how far the rest of the line moved right after a slip
  for (const g of glyphs) {
    if (g.type === "space" || !g.glyph) continue;
    let x = g.placeX + shift + (rng() - 0.5) * 3.5 * MESS;
    const y = g.baseline + drift(x) + (rng() - 0.5) * 4 * MESS;
    if (g.type === "fallback") {
      for (const s of textToStrokes(g.label, line, x, fontH * 1.15, false)) out.push(s);
      continue;
    }
    const sizeJ = 1 + (rng() - 0.5) * 0.24 * MESS;
    const rot = g.rotationRad + (rng() - 0.5) * 0.16 * MESS;
    const H = g.scaledHeight * sizeJ;
    const { scaled, cy } = placement(g.label, H, y, g.verticalOffset);

    if (g === slipAt) {
      // Write a different character first, scratch it out, then carry on
      // to the right of it with the correct one.
      const labels = [...library.byLabel.keys()].filter((l) => l !== g.label && /^[0-9a-z]$/i.test(l));
      const wrongLabel = labels[Math.floor(rng() * labels.length)];
      const variants = wrongLabel ? library.byLabel.get(wrongLabel) : undefined;
      const wrong = variants?.[Math.floor(rng() * variants.length)];
      if (wrong) {
        const wW = wrong.width * H;
        for (const s of glyphInk(wrong, x + wW / 2, cy, scaled, rot, rng, fontH)) out.push(s);
        out.push(scribble(x, x + wW, cy - scaled * 0.4, cy + scaled * 0.4, rng));
        const step = wW + 6;
        shift += step;
        x += step;
      }
    }
    const cx = x + (g.glyph.width * H) / 2;
    for (const s of glyphInk(g.glyph, cx, cy, scaled, rot, rng, fontH)) out.push(s);
  }
  return out;
}

/**
 * Write text on a ruled line in the loaded handwriting (the glyph dataset),
 * as pen strokes the board treats like any other ink. Characters the
 * dataset doesn't have fall back to the handwriting font.
 */
/** The checker's dialect, written the way a human writes it: "int v du" is ∫v du. */
export function displayMath(text: string): string {
  return text
    .replace(/\bintegrate\b/gi, "∫")
    .replace(/\bint\b/g, "∫")
    .replace(/\bsqrt\b/g, "√")
    .replace(/\boo\b/g, "∞")
    .replace(/<=/g, "≤")
    .replace(/>=/g, "≥")
    .replace(/!=/g, "≠")
    .replace(/∫\s+/g, "∫");
}

export function glyphStrokes(text: string, line: number, library: GlyphLibrary, x0 = 28, remember = true): Stroke[] {
  const top = (line - 1) * LINE_H;
  const baseline = top + LINE_H * 0.74;
  const shown = displayMath(text);
  const out = inkFor(shown, library, x0, baseline, FONT_H, seedOf(shown, line), line);
  // The tag keeps the original dialect, so the server reads the line verbatim.
  if (remember && out.length) rememberText(out, text);
  return out;
}

/**
 * A line of text drawn in the handwriting onto a fresh canvas (for the PDF
 * heading), with the same pen as the board. Returns null if the text is empty.
 */
export function handwritingCanvas(text: string, library: GlyphLibrary, fontH = 44, scale = 2): HTMLCanvasElement | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const strokes = inkFor(clean, library, 8, fontH * 1.25, fontH, seedOf(clean, 0), 1);
  if (!strokes.length) return null;
  const maxX = Math.max(...strokes.map((s) => s.box.maxX));
  const width = Math.ceil(maxX + 16);
  const height = Math.ceil(fontH * 1.75);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#111111";
  for (const s of strokes) ctx.fill(strokePath(s));
  return canvas;
}
