import type { Point, Stroke, NormalizedGlyph, RawSample } from "../types/handwriting";

const MIN_DIST = 0.5;

function dist(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Remove consecutive nearly-identical points (<0.5px apart) but keep stroke structure. */
function deduplicateStroke(stroke: Stroke): Stroke {
  if (stroke.length === 0) return [];
  const out: Point[] = [{ x: stroke[0].x, y: stroke[0].y }];
  for (let i = 1; i < stroke.length; i++) {
    const p = stroke[i];
    const last = out[out.length - 1];
    if (dist(last, p) >= MIN_DIST) {
      out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}

/**
 * Preprocess a raw sample into a normalized glyph.
 * Returns null if the sample should be skipped.
 */
export function preprocessGlyph(sample: RawSample): NormalizedGlyph | null {
  // Deduplicate each stroke and strip timing/pressure
  const cleanStrokes: Stroke[] = sample.strokes
    .map(deduplicateStroke)
    .filter((s) => s.length > 0);

  if (cleanStrokes.length === 0) return null;

  // Compute bounding box across all points
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const stroke of cleanStrokes) {
    for (const p of stroke) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  const glyphHeight = maxY - minY;
  const glyphWidth = maxX - minX;

  // Guard against degenerate glyphs
  if (glyphHeight < 1) return null;

  // Normalize: divide by height to preserve aspect ratio
  const normalizedStrokes: Stroke[] = cleanStrokes.map((stroke) =>
    stroke.map((p) => ({
      x: (p.x - minX) / glyphHeight,
      y: (p.y - minY) / glyphHeight,
    }))
  );

  return {
    label: sample.label,
    strokes: normalizedStrokes,
    width: glyphWidth / glyphHeight,
    height: 1,
    sourceId: sample.id,
  };
}
