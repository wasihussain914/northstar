import { layoutText } from "../glyphs/lib/renderText";
import { transformPoint } from "../glyphs/lib/inkMask";
import type { GlyphLibrary } from "../glyphs/types/handwriting";
import { LINE_H, lineOf, makeStroke, type Point, type Stroke } from "./geometry";

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

/** Large enough to fill a ruled line; not the 20px red margin-note size. */
const FIX_FONT_HEIGHT = Math.round(LINE_H * 0.58);

/**
 * Turn plain text into black board strokes on a ruled line, using the personal
 * glyph library. The text is remembered so the next check gets it verbatim.
 */
export function textToStrokes(text: string, line: number, library: GlyphLibrary, x0 = 28): Stroke[] {
  const phrase = text.trim();
  if (!phrase) return [];

  const baseline = (line - 1) * LINE_H + LINE_H * 0.72;
  const seed = line * 997 + (phrase.charCodeAt(0) || 0);
  const result = layoutText(phrase, library, x0, baseline, {
    fontHeight: FIX_FONT_HEIGHT,
    inkClearance: 1,
    strokeWidthPx: 2.2,
    seed,
  });

  const strokes: Stroke[] = [];
  for (const layout of result.glyphs) {
    if (!layout.glyph || layout.type === "space") continue;
    const scaledHeight = layout.scaledHeight;
    const cx = layout.placeX + (layout.glyph.width * scaledHeight) / 2;
    const cy = layout.baseline + layout.verticalOffset - scaledHeight / 2;
    for (const gStroke of layout.glyph.strokes) {
      if (gStroke.length === 0) continue;
      const points: Point[] = [];
      for (const p of gStroke) {
        const pt = transformPoint(p, layout.glyph, cx, cy, scaledHeight, layout.rotationRad);
        points.push([pt.x, pt.y, 0.5]);
      }
      if (points.length === 1) {
        points.push([points[0][0] + 0.5, points[0][1], 0.5]);
      }
      strokes.push(makeStroke(points, true));
    }
  }
  if (strokes.length) typed.set(strokes[0], phrase);
  return strokes;
}
