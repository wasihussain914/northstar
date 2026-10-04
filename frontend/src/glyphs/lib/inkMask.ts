import type { NormalizedGlyph, Point } from "../types/handwriting";
import { MASK_CELLS_PER_HEIGHT, MASK_BRUSH_RADIUS_CELLS } from "./variation";

export type InkMask = {
  /** Flat boolean array: cells[row * cols + col] */
  cells: Uint8Array;
  rows: number;
  cols: number;
  /** CSS-pixel x of the left edge of cell 0 */
  originX: number;
  /** CSS-pixel y of the top edge of row 0 */
  originY: number;
  /** CSS pixels per cell */
  cellSize: number;
};

/**
 * Transform a normalized glyph point to CSS pixel space.
 * The glyph center is at (cx, cy), scaled by scaledHeight,
 * rotated by rotationRad, and then placed so that the bbox bottom
 * sits on the baseline + verticalOffset.
 */
export function transformPoint(
  p: Point,
  glyph: NormalizedGlyph,
  cx: number,
  cy: number,
  scaledHeight: number,
  rotationRad: number
): { x: number; y: number } {
  // Normalized glyph center is at (width/2, 0.5)
  const nx = p.x - glyph.width / 2;
  const ny = p.y - 0.5;

  // Scale
  const sx = nx * scaledHeight;
  const sy = ny * scaledHeight;

  // Rotate
  const cosR = Math.cos(rotationRad);
  const sinR = Math.sin(rotationRad);
  const rx = sx * cosR - sy * sinR;
  const ry = sx * sinR + sy * cosR;

  return { x: cx + rx, y: cy + ry };
}

/**
 * Build an ink occupancy mask for a single glyph placed at a given x offset.
 * The mask covers the full extent of the transformed glyph.
 *
 * @param glyph          Normalized glyph
 * @param placeX         CSS-pixel left edge of the glyph bbox
 * @param baseline       CSS-pixel baseline y
 * @param scaledHeight   fontHeight * glyphScale
 * @param rotationRad    rotation in radians
 * @param verticalOffset vertical jitter in CSS pixels
 * @param strokeWidthPx  stroke width in CSS pixels
 */
export function buildInkMask(
  glyph: NormalizedGlyph,
  placeX: number,
  baseline: number,
  scaledHeight: number,
  rotationRad: number,
  verticalOffset: number,
  strokeWidthPx: number
): InkMask {
  const cellSize = scaledHeight / MASK_CELLS_PER_HEIGHT;
  const brushRadius = Math.max(
    1,
    Math.ceil((strokeWidthPx / 2 / cellSize) + MASK_BRUSH_RADIUS_CELLS)
  );

  // The glyph bbox bottom is on baseline + verticalOffset.
  // Center y is at baseline + verticalOffset - scaledHeight/2.
  const cx = placeX + (glyph.width * scaledHeight) / 2;
  const cy = baseline + verticalOffset - scaledHeight / 2;

  // Collect all transformed points to find extent
  const allPts: { x: number; y: number }[] = [];
  for (const stroke of glyph.strokes) {
    for (const p of stroke) {
      allPts.push(transformPoint(p, glyph, cx, cy, scaledHeight, rotationRad));
    }
  }

  if (allPts.length === 0) {
    return { cells: new Uint8Array(0), rows: 0, cols: 0, originX: cx, originY: cy, cellSize };
  }

  // Compute extent in CSS pixels including brush radius in cells
  const marginPx = (brushRadius + 1) * cellSize;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const pt of allPts) {
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }
  minX -= marginPx; maxX += marginPx;
  minY -= marginPx; maxY += marginPx;

  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cellSize));
  const cells = new Uint8Array(rows * cols);

  /** Mark a cell and its brush neighborhood as ink */
  function markCell(col: number, row: number) {
    for (let dr = -brushRadius; dr <= brushRadius; dr++) {
      for (let dc = -brushRadius; dc <= brushRadius; dc++) {
        const r2 = dr * dr + dc * dc;
        if (r2 > brushRadius * brushRadius) continue;
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          cells[nr * cols + nc] = 1;
        }
      }
    }
  }

  // Rasterize each stroke segment into cells
  for (const stroke of glyph.strokes) {
    if (stroke.length === 0) continue;

    // Single-point strokes
    if (stroke.length === 1) {
      const pt = transformPoint(stroke[0], glyph, cx, cy, scaledHeight, rotationRad);
      const col = Math.floor((pt.x - minX) / cellSize);
      const row = Math.floor((pt.y - minY) / cellSize);
      markCell(col, row);
      continue;
    }

    for (let i = 0; i < stroke.length - 1; i++) {
      const a = transformPoint(stroke[i], glyph, cx, cy, scaledHeight, rotationRad);
      const b = transformPoint(stroke[i + 1], glyph, cx, cy, scaledHeight, rotationRad);

      // Walk along the segment in cell-size steps
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(1, Math.ceil(segLen / cellSize));
      for (let t = 0; t <= steps; t++) {
        const px = a.x + (dx * t) / steps;
        const py = a.y + (dy * t) / steps;
        const col = Math.floor((px - minX) / cellSize);
        const row = Math.floor((py - minY) / cellSize);
        if (col >= 0 && col < cols && row >= 0 && row < rows) {
          markCell(col, row);
        }
      }
    }
  }

  return { cells, rows, cols, originX: minX, originY: minY, cellSize };
}

/**
 * Check whether two masks collide if the new mask is shifted horizontally by xShift.
 * Returns true if any black cell of newMask overlaps a black cell of existingMasks.
 */
export function masksCollide(
  existing: InkMask[],
  newMask: InkMask,
  xShift: number
): boolean {
  const nx0 = newMask.originX + xShift;
  const nx1 = nx0 + newMask.cols * newMask.cellSize;

  for (const em of existing) {
    // Quick bbox reject
    const ex0 = em.originX;
    const ex1 = ex0 + em.cols * em.cellSize;
    if (nx1 <= ex0 || nx0 >= ex1) continue;
    if (newMask.originY + newMask.rows * newMask.cellSize <= em.originY) continue;
    if (newMask.originY >= em.originY + em.rows * em.cellSize) continue;

    // Per-cell check
    for (let nr = 0; nr < newMask.rows; nr++) {
      for (let nc = 0; nc < newMask.cols; nc++) {
        if (!newMask.cells[nr * newMask.cols + nc]) continue;

        const worldX = nx0 + (nc + 0.5) * newMask.cellSize;
        const worldY = newMask.originY + (nr + 0.5) * newMask.cellSize;

        const ec = Math.floor((worldX - ex0) / em.cellSize);
        const er = Math.floor((worldY - em.originY) / em.cellSize);
        if (ec >= 0 && ec < em.cols && er >= 0 && er < em.rows) {
          if (em.cells[er * em.cols + ec]) return true;
        }
      }
    }
  }
  return false;
}
