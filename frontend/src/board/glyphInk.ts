import { layoutText } from "../glyphs/lib/renderText";
import { transformPoint } from "../glyphs/lib/inkMask";
import { drawGlyph } from "../glyphs/lib/renderGlyph";
import type { GlyphLibrary } from "../glyphs/types/handwriting";
import { LINE_H, makeStroke, type Point, type Stroke } from "./geometry";
import { rememberText, textToStrokes } from "./handwriting";

/** Ink height of a written line, in board units. */
const FONT_H = 40;

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
};

/** Size and centre for a laid-out glyph, honouring the SMALL table. */
function placement(label: string, scaledHeight: number, baseline: number, verticalOffset: number) {
  const small = SMALL[label];
  if (!small) return { scaled: scaledHeight, cy: baseline + verticalOffset - scaledHeight / 2 };
  return { scaled: scaledHeight * small.h, cy: baseline + verticalOffset - scaledHeight * small.mid };
}

/** A stable seed per line so the same text always lays out the same way. */
function seedOf(text: string, line: number): number {
  let h = line * 7919;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * Write text on a ruled line in the loaded handwriting (the glyph dataset),
 * as pen strokes the board treats like any other ink. Characters the
 * dataset doesn't have fall back to the handwriting font.
 */
export function glyphStrokes(text: string, line: number, library: GlyphLibrary, x0 = 28, remember = true): Stroke[] {
  const top = (line - 1) * LINE_H;
  const baseline = top + LINE_H * 0.74;
  const { glyphs } = layoutText(text, library, x0, baseline, { fontHeight: FONT_H, seed: seedOf(text, line) });
  const out: Stroke[] = [];
  for (const g of glyphs) {
    if (g.type === "space" || !g.glyph) continue;
    if (g.type === "fallback") {
      // Not in the dataset: the font version of just this character, in place.
      for (const s of textToStrokes(g.label, line, g.placeX, FONT_H * 1.15, false)) out.push(s);
      continue;
    }
    const { scaled, cy } = placement(g.label, g.scaledHeight, g.baseline, g.verticalOffset);
    const cx = g.placeX + (g.glyph.width * g.scaledHeight) / 2;
    for (const stroke of g.glyph.strokes) {
      if (!stroke.length) continue;
      const pts: Point[] = stroke.map((p) => {
        const q = transformPoint(p, g.glyph!, cx, cy, scaled, g.rotationRad);
        return [q.x, q.y, 0.5];
      });
      // A dot: give it a little length so it gets an outline.
      if (pts.length === 1) pts.push([pts[0][0] + 0.8, pts[0][1] + 0.8, 0.5]);
      out.push(makeStroke(pts, true));
    }
  }
  if (remember && out.length) rememberText(out, text);
  return out;
}

/**
 * A line of text drawn in the handwriting onto a fresh canvas (for the PDF
 * heading). Returns null if the text is empty.
 */
export function handwritingCanvas(text: string, library: GlyphLibrary, fontH = 44, scale = 2): HTMLCanvasElement | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const probe = layoutText(clean, library, 8, fontH * 1.2, { fontHeight: fontH, seed: seedOf(clean, 0) });
  const width = Math.ceil(probe.totalWidth + 24);
  const height = Math.ceil(fontH * 1.7);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  for (const g of probe.glyphs) {
    if (g.type === "space" || !g.glyph) continue;
    if (g.type === "fallback") {
      ctx.font = `${fontH}px "Bradley Hand", "Noteworthy", "Chalkboard SE", cursive`;
      ctx.fillStyle = "#111";
      ctx.fillText(g.label, g.placeX, g.baseline);
      continue;
    }
    const small = SMALL[g.label];
    const opts = { ...g.drawOpts, strokeStyle: "#111111", strokeWidthPx: 3 };
    if (small) {
      // drawGlyph centres at baseline + verticalOffset - scaledHeight/2; move
      // that centre to where the small mark belongs, at its natural size.
      const scaled = g.scaledHeight * small.h;
      opts.glyphScale = g.drawOpts.glyphScale * small.h;
      opts.verticalOffset = g.verticalOffset - g.scaledHeight * small.mid + scaled / 2;
      // Keep the mark's horizontal centre where the full-size layout put it.
      const dx = ((g.glyph.width * g.scaledHeight) - (g.glyph.width * scaled)) / 2;
      drawGlyph(ctx, g.glyph, g.placeX + dx, g.baseline, opts);
      continue;
    }
    drawGlyph(ctx, g.glyph, g.placeX, g.baseline, opts);
  }
  return canvas;
}
