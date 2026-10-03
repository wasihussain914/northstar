import type { NormalizedGlyph } from "../types/handwriting";
import { transformPoint } from "./inkMask";

export type DrawGlyphOptions = {
  fontHeight: number;
  glyphScale: number;
  rotationRad: number;
  verticalOffset: number;
  strokeWidthPx: number;
  strokeStyle: string;
};

/**
 * Draw a normalized glyph onto a canvas context.
 * The glyph bbox bottom is placed at (placeX + width/2, baseline + verticalOffset).
 *
 * @param ctx        Canvas 2D context
 * @param glyph      Normalized glyph
 * @param placeX     CSS-pixel left edge (baseline of bbox)
 * @param baseline   CSS-pixel y of the baseline
 * @param opts       Drawing options
 */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: NormalizedGlyph,
  placeX: number,
  baseline: number,
  opts: DrawGlyphOptions
): void {
  const scaledHeight = opts.fontHeight * opts.glyphScale;
  const cx = placeX + (glyph.width * scaledHeight) / 2;
  const cy = baseline + opts.verticalOffset - scaledHeight / 2;

  ctx.save();
  ctx.strokeStyle = opts.strokeStyle;
  ctx.lineWidth = opts.strokeWidthPx;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stroke of glyph.strokes) {
    if (stroke.length === 0) continue;

    if (stroke.length === 1) {
      // Single point: draw a dot
      const pt = transformPoint(stroke[0], glyph, cx, cy, scaledHeight, opts.rotationRad);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, opts.strokeWidthPx / 2, 0, Math.PI * 2);
      ctx.fillStyle = opts.strokeStyle;
      ctx.fill();
      continue;
    }

    ctx.beginPath();
    const first = transformPoint(stroke[0], glyph, cx, cy, scaledHeight, opts.rotationRad);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < stroke.length; i++) {
      const pt = transformPoint(stroke[i], glyph, cx, cy, scaledHeight, opts.rotationRad);
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Draw a single stroke (partial, for animation) of a glyph.
 * strokeIdx is which stroke in glyph.strokes, pointCount how many points of it.
 */
export function drawGlyphPartialStroke(
  ctx: CanvasRenderingContext2D,
  glyph: NormalizedGlyph,
  placeX: number,
  baseline: number,
  opts: DrawGlyphOptions,
  strokeIdx: number,
  pointCount: number
): void {
  const scaledHeight = opts.fontHeight * opts.glyphScale;
  const cx = placeX + (glyph.width * scaledHeight) / 2;
  const cy = baseline + opts.verticalOffset - scaledHeight / 2;

  const stroke = glyph.strokes[strokeIdx];
  if (!stroke || pointCount === 0) return;

  ctx.save();
  ctx.strokeStyle = opts.strokeStyle;
  ctx.lineWidth = opts.strokeWidthPx;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const count = Math.min(pointCount, stroke.length);

  if (count === 1) {
    const pt = transformPoint(stroke[0], glyph, cx, cy, scaledHeight, opts.rotationRad);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, opts.strokeWidthPx / 2, 0, Math.PI * 2);
    ctx.fillStyle = opts.strokeStyle;
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  const first = transformPoint(stroke[0], glyph, cx, cy, scaledHeight, opts.rotationRad);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < count; i++) {
    const pt = transformPoint(stroke[i], glyph, cx, cy, scaledHeight, opts.rotationRad);
    ctx.lineTo(pt.x, pt.y);
  }
  ctx.stroke();
  ctx.restore();
}
