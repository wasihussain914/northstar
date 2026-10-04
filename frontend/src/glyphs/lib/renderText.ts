import type { NormalizedGlyph, GlyphLibrary } from "../types/handwriting";
import { makePrng } from "./rng";
import { buildInkMask, masksCollide, type InkMask } from "./inkMask";
import { drawGlyph, type DrawGlyphOptions } from "./renderGlyph";
import {
  SCALE_JITTER,
  ROTATION_JITTER_DEG,
  VERTICAL_JITTER_PX,
  SPACE_WIDTH_FACTOR,
  DEFAULT_INK_CLEARANCE,
  DEFAULT_STROKE_WIDTH,
} from "./variation";

export type RenderTextOptions = {
  fontHeight: number;
  inkClearance?: number;
  strokeWidthPx?: number;
  strokeStyle?: string;
  seed?: number;
};

/** Per-glyph layout info produced by layoutText */
export type GlyphLayout = {
  type: "glyph" | "fallback" | "space";
  label: string;
  glyph: NormalizedGlyph | null;
  placeX: number;
  baseline: number;
  glyphScale: number;
  rotationRad: number;
  verticalOffset: number;
  scaledHeight: number;
  drawOpts: DrawGlyphOptions;
  /** Right ink edge in CSS pixels (for cursor advance) */
  rightEdge: number;
};

/** Result of layoutText */
export type LayoutResult = {
  glyphs: GlyphLayout[];
  missingLabels: string[];
  totalWidth: number;
};

const DEG_TO_RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// Hardcoded glyphs — override the library for characters that are cleanest
// as simple geometric strokes (minus, en-dash, etc.).
// ---------------------------------------------------------------------------

/** A single horizontal stroke at mid-height, aspect ratio ~0.65. */
function makeMinus(label: string): NormalizedGlyph {
  return {
    label,
    strokes: [[{ x: 0.05, y: 0.5 }, { x: 0.6, y: 0.5 }]],
    width: 0.65,
    height: 1,
    sourceId: "__hardcoded__",
  };
}

/** Characters whose glyph is always hardcoded regardless of what is in the library. */
const HARDCODED_GLYPHS: Map<string, NormalizedGlyph> = new Map([
  ["-",  makeMinus("-")],
  ["−",  makeMinus("−")],   // Unicode minus sign U+2212
  ["–",  makeMinus("–")],   // en-dash U+2013
]);

/**
 * Fallback glyph for unknown characters.
 * Just a thin rectangle outline, normalized to 0.5 wide x 1 tall.
 */
function makeFallbackGlyph(label: string): NormalizedGlyph {
  return {
    label,
    strokes: [
      [
        { x: 0.05, y: 0.05 },
        { x: 0.45, y: 0.05 },
        { x: 0.45, y: 0.95 },
        { x: 0.05, y: 0.95 },
        { x: 0.05, y: 0.05 },
      ],
    ],
    width: 0.5,
    height: 1,
    sourceId: "__fallback__",
  };
}

/**
 * Compute the right-most ink x position in CSS pixels for a placed glyph.
 */
function computeRightEdge(layout: Omit<GlyphLayout, "rightEdge">): number {
  if (!layout.glyph || layout.type === "space") {
    return layout.placeX + layout.scaledHeight * SPACE_WIDTH_FACTOR;
  }
  const scaledHeight = layout.scaledHeight;
  const cx = layout.placeX + (layout.glyph.width * scaledHeight) / 2;

  let maxX = -Infinity;
  for (const stroke of layout.glyph.strokes) {
    for (const p of stroke) {
      const nx = p.x - layout.glyph.width / 2;
      const ny = p.y - 0.5;
      const sx = nx * scaledHeight;
      const sy = ny * scaledHeight;
      const cosR = Math.cos(layout.rotationRad);
      const sinR = Math.sin(layout.rotationRad);
      const wx = cx + sx * cosR - sy * sinR;
      if (wx > maxX) maxX = wx;
    }
  }
  return maxX === -Infinity ? layout.placeX + layout.scaledHeight * 0.5 : maxX;
}

/**
 * Lay out a string into positioned glyphs using ink-mask packing.
 *
 * @param text        Text to render
 * @param library     Loaded glyph library
 * @param startX      Left edge in CSS pixels
 * @param baseline    Y baseline in CSS pixels
 * @param opts        Render options
 */
export function layoutText(
  text: string,
  library: GlyphLibrary,
  startX: number,
  baseline: number,
  opts: RenderTextOptions
): LayoutResult {
  const fontHeight = opts.fontHeight;
  const inkClearance = opts.inkClearance ?? DEFAULT_INK_CLEARANCE;
  const strokeWidthPx = opts.strokeWidthPx ?? DEFAULT_STROKE_WIDTH;
  const strokeStyle = opts.strokeStyle ?? "#1a1a1a";
  const rng = makePrng(opts.seed ?? 42);

  const chars = Array.from(text);
  const glyphs: GlyphLayout[] = [];
  const missingLabels: string[] = [];
  const placedMasks: InkMask[] = [];

  let cursorX = startX;

  for (const char of chars) {
    // Space
    if (char === " ") {
      const spaceWidth = fontHeight * SPACE_WIDTH_FACTOR;
      const partial: Omit<GlyphLayout, "rightEdge"> = {
        type: "space",
        label: " ",
        glyph: null,
        placeX: cursorX,
        baseline,
        glyphScale: 1,
        rotationRad: 0,
        verticalOffset: 0,
        scaledHeight: fontHeight,
        drawOpts: {
          fontHeight,
          glyphScale: 1,
          rotationRad: 0,
          verticalOffset: 0,
          strokeWidthPx,
          strokeStyle,
        },
      };
      glyphs.push({ ...partial, rightEdge: cursorX + spaceWidth });
      cursorX += spaceWidth;
      continue;
    }

    // Random variation
    const glyphScale = 1 - SCALE_JITTER + rng() * SCALE_JITTER * 2;
    const rotationRad = (-ROTATION_JITTER_DEG + rng() * ROTATION_JITTER_DEG * 2) * DEG_TO_RAD;
    const verticalOffset = (-VERTICAL_JITTER_PX + rng() * VERTICAL_JITTER_PX * 2);

    const scaledHeight = fontHeight * glyphScale;

    // Find glyph variant — hardcoded shapes take priority over the library
    const hardcoded = HARDCODED_GLYPHS.get(char);
    const variants = hardcoded ? null : library.byLabel.get(char);
    let glyph: NormalizedGlyph;
    let isFallback = false;

    if (hardcoded) {
      glyph = hardcoded;
    } else if (!variants || variants.length === 0) {
      if (!missingLabels.includes(char)) missingLabels.push(char);
      glyph = makeFallbackGlyph(char);
      isFallback = true;
    } else {
      const idx = Math.floor(rng() * variants.length);
      glyph = variants[idx];
    }

    const drawOpts: DrawGlyphOptions = {
      fontHeight,
      glyphScale,
      rotationRad,
      verticalOffset,
      strokeWidthPx,
      strokeStyle,
    };

    // Ink-mask packing: binary search for leftmost x where ink doesn't collide
    // The mask is built relative to placeX=0 and then tested with an xShift
    const testMask = buildInkMask(
      glyph,
      0, // relative, we'll shift below
      baseline,
      scaledHeight,
      rotationRad,
      verticalOffset,
      strokeWidthPx
    );

    let placeX: number;

    if (placedMasks.length === 0 || testMask.cols === 0) {
      placeX = cursorX;
    } else {
      // Start trying from cursorX, then slide right until no collision
      // Lower bound: cursorX + inkClearance
      // Upper bound: cursorX + scaledHeight * 2 (safety)
      const lo = cursorX + inkClearance;
      const hi = cursorX + scaledHeight * 3;
      const step = testMask.cellSize;

      placeX = lo;
      for (let x = lo; x < hi; x += step) {
        // xShift = x (since mask was built at placeX=0)
        if (!masksCollide(placedMasks, testMask, x)) {
          placeX = x;
          break;
        }
        placeX = x + step;
      }
      // Apply clearance: ensure gap from last ink right edge
      const minX = cursorX + inkClearance;
      if (placeX < minX) placeX = minX;
    }

    const partial: Omit<GlyphLayout, "rightEdge"> = {
      type: isFallback ? "fallback" : "glyph",
      label: char,
      glyph,
      placeX,
      baseline,
      glyphScale,
      rotationRad,
      verticalOffset,
      scaledHeight,
      drawOpts,
    };

    const rightEdge = computeRightEdge(partial);
    const layout: GlyphLayout = { ...partial, rightEdge };
    glyphs.push(layout);

    // Build final mask at the chosen placeX and add to the placed list
    const finalMask = buildInkMask(
      glyph,
      placeX,
      baseline,
      scaledHeight,
      rotationRad,
      verticalOffset,
      strokeWidthPx
    );
    placedMasks.push(finalMask);

    // Advance cursor to right ink edge
    cursorX = rightEdge;
  }

  const totalWidth =
    glyphs.length > 0
      ? Math.max(...glyphs.map((g) => g.rightEdge)) - startX
      : 0;

  return { glyphs, missingLabels, totalWidth };
}

/**
 * Render text immediately onto a canvas context.
 */
export function renderText(
  ctx: CanvasRenderingContext2D,
  text: string,
  library: GlyphLibrary,
  startX: number,
  baseline: number,
  opts: RenderTextOptions
): LayoutResult {
  const result = layoutText(text, library, startX, baseline, opts);

  for (const layout of result.glyphs) {
    if (layout.type === "space") continue;
    if (!layout.glyph) continue;

    if (layout.type === "fallback") {
      // Draw small fallback box
      ctx.save();
      ctx.strokeStyle = "#888";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        layout.placeX + 1,
        layout.baseline - layout.scaledHeight + 1,
        layout.scaledHeight * 0.5 - 2,
        layout.scaledHeight - 2
      );
      ctx.restore();
    } else {
      drawGlyph(ctx, layout.glyph, layout.placeX, layout.baseline, layout.drawOpts);
    }
  }

  return result;
}
