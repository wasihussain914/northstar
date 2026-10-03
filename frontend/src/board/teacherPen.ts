/**
 * Teacher pen: turn a short phrase into red handwriting strokes on the board.
 *
 * Letters are stored as hand-drawn polylines (not scanlines or filled outlines).
 * Each glyph path goes through `perfect-freehand` so stroke width varies with a
 * synthetic pressure curve that starts light, peaks in the middle, and tapers off –
 * exactly how a marker feels when a teacher quickly jots a margin note.
 *
 * Rendering is kept separate from student strokes so the board snapshot Claude
 * receives never contains teacher ink, and SymPy never treats it as a new step.
 */

import { LINE_H, lineOf, outlinePath, type Point, type Stroke } from "./geometry";

// ---------------------------------------------------------------------------
// Rendering constants
// ---------------------------------------------------------------------------

/** Cap height of teacher writing in board pixels. */
const CAP_H = 26;

// ---------------------------------------------------------------------------
// Glyph library
//
// Coordinate system per glyph:
//   x: 0 = left edge, increases rightward; `advance` = total horizontal step
//   y: 0 = cap-top, 1.0 = baseline, 1.3 = descender bottom
//
// Each glyph is one or more pen-down polylines ([x, y] pairs).  The lines are
// rough intentionally: perfect-freehand smooths them into natural-looking curves.
// ---------------------------------------------------------------------------

interface Glyph {
  advance: number; // horizontal advance in normalised units (multiply by CAP_H)
  paths: [number, number][][]; // one or more pen paths
}

/* eslint-disable key-spacing */
const G: Record<string, Glyph> = {
  " ": { advance: 0.32, paths: [] },
  a: { advance: 0.60, paths: [[[0.52,0.30],[0.38,0.12],[0.18,0.10],[0.06,0.30],[0.05,0.60],[0.14,0.82],[0.34,0.92],[0.52,0.78],[0.52,0.92]]] },
  b: { advance: 0.62, paths: [[[0.14,0.00],[0.14,1.00]], [[0.14,0.35],[0.28,0.22],[0.50,0.32],[0.56,0.58],[0.48,0.82],[0.26,0.92],[0.14,0.78]]] },
  c: { advance: 0.56, paths: [[[0.58,0.24],[0.42,0.10],[0.20,0.08],[0.06,0.28],[0.04,0.62],[0.14,0.84],[0.36,0.92],[0.56,0.80]]] },
  d: { advance: 0.62, paths: [[[0.52,0.00],[0.52,1.00]], [[0.52,0.28],[0.36,0.12],[0.14,0.16],[0.04,0.40],[0.06,0.68],[0.20,0.88],[0.42,0.92],[0.52,0.76]]] },
  e: { advance: 0.60, paths: [[[0.06,0.52],[0.52,0.48],[0.56,0.28],[0.42,0.10],[0.20,0.08],[0.06,0.30],[0.04,0.64],[0.18,0.88],[0.44,0.92],[0.58,0.78]]] },
  f: { advance: 0.40, paths: [[[0.44,0.06],[0.30,0.00],[0.16,0.04],[0.12,0.22],[0.12,1.00]], [[0.02,0.32],[0.38,0.32]]] },
  g: { advance: 0.62, paths: [[[0.58,0.25],[0.42,0.10],[0.18,0.10],[0.05,0.34],[0.05,0.65],[0.18,0.86],[0.44,0.90],[0.58,0.72],[0.58,1.08],[0.44,1.28],[0.18,1.30]]] },
  h: { advance: 0.62, paths: [[[0.12,0.00],[0.12,1.00]], [[0.12,0.42],[0.26,0.22],[0.46,0.16],[0.58,0.32],[0.58,1.00]]] },
  i: { advance: 0.32, paths: [[[0.18,0.24],[0.18,0.90]], [[0.13,0.10],[0.22,0.13]]] },
  j: { advance: 0.32, paths: [[[0.24,0.22],[0.24,1.06],[0.14,1.26],[0.04,1.20]], [[0.19,0.10],[0.28,0.13]]] },
  k: { advance: 0.56, paths: [[[0.12,0.00],[0.12,1.00]], [[0.54,0.18],[0.22,0.52],[0.54,0.92]]] },
  l: { advance: 0.30, paths: [[[0.14,0.00],[0.14,0.92],[0.26,1.00]]] },
  m: { advance: 0.84, paths: [[[0.08,0.22],[0.08,1.00]], [[0.08,0.34],[0.20,0.16],[0.36,0.18],[0.44,0.34],[0.44,1.00]], [[0.44,0.34],[0.56,0.16],[0.72,0.18],[0.80,0.34],[0.80,1.00]]] },
  n: { advance: 0.62, paths: [[[0.10,0.22],[0.10,1.00]], [[0.10,0.34],[0.24,0.16],[0.46,0.16],[0.58,0.32],[0.58,1.00]]] },
  o: { advance: 0.62, paths: [[[0.32,0.08],[0.14,0.20],[0.04,0.50],[0.10,0.76],[0.32,0.92],[0.54,0.76],[0.60,0.50],[0.54,0.22],[0.32,0.08]]] },
  p: { advance: 0.62, paths: [[[0.14,0.20],[0.14,1.32]], [[0.14,0.22],[0.32,0.10],[0.52,0.22],[0.56,0.52],[0.44,0.76],[0.22,0.86],[0.14,0.72]]] },
  q: { advance: 0.62, paths: [[[0.52,0.20],[0.52,1.32]], [[0.52,0.26],[0.34,0.10],[0.12,0.16],[0.04,0.42],[0.08,0.70],[0.28,0.88],[0.52,0.76]]] },
  r: { advance: 0.44, paths: [[[0.10,0.22],[0.10,1.00]], [[0.10,0.36],[0.20,0.18],[0.36,0.12],[0.50,0.22]]] },
  s: { advance: 0.52, paths: [[[0.52,0.22],[0.34,0.10],[0.14,0.14],[0.06,0.32],[0.20,0.52],[0.40,0.56],[0.52,0.72],[0.40,0.88],[0.14,0.90],[0.04,0.78]]] },
  t: { advance: 0.42, paths: [[[0.24,0.05],[0.24,0.90],[0.36,1.00]], [[0.04,0.30],[0.44,0.28]]] },
  u: { advance: 0.62, paths: [[[0.10,0.20],[0.10,0.72],[0.22,0.92],[0.44,0.90],[0.58,0.72],[0.58,0.20]]] },
  v: { advance: 0.56, paths: [[[0.04,0.18],[0.28,0.96],[0.54,0.18]]] },
  w: { advance: 0.74, paths: [[[0.04,0.18],[0.18,0.96],[0.36,0.50],[0.54,0.96],[0.70,0.18]]] },
  x: { advance: 0.54, paths: [[[0.04,0.16],[0.52,0.94]], [[0.52,0.16],[0.04,0.94]]] },
  y: { advance: 0.54, paths: [[[0.04,0.18],[0.28,0.72]], [[0.52,0.18],[0.28,0.72],[0.10,1.30]]] },
  z: { advance: 0.52, paths: [[[0.04,0.14],[0.50,0.14],[0.04,0.90],[0.50,0.90]]] },
  "0": { advance: 0.60, paths: [[[0.30,0.00],[0.10,0.14],[0.04,0.42],[0.10,0.72],[0.30,0.86],[0.54,0.72],[0.60,0.42],[0.52,0.14],[0.30,0.00]]] },
  "1": { advance: 0.38, paths: [[[0.10,0.16],[0.22,0.04],[0.22,0.92]]] },
  "2": { advance: 0.54, paths: [[[0.08,0.18],[0.22,0.04],[0.44,0.04],[0.54,0.20],[0.52,0.38],[0.10,0.76],[0.04,0.90],[0.58,0.90]]] },
  "3": { advance: 0.54, paths: [[[0.08,0.06],[0.40,0.06],[0.54,0.22],[0.52,0.44],[0.28,0.52],[0.52,0.62],[0.54,0.80],[0.40,0.96],[0.08,0.94]]] },
  "4": { advance: 0.56, paths: [[[0.44,0.00],[0.04,0.62],[0.58,0.62]], [[0.44,0.00],[0.44,0.96]]] },
  "5": { advance: 0.54, paths: [[[0.50,0.04],[0.04,0.04],[0.04,0.48],[0.28,0.38],[0.50,0.48],[0.54,0.68],[0.42,0.86],[0.18,0.92],[0.04,0.82]]] },
  "6": { advance: 0.56, paths: [[[0.50,0.08],[0.26,0.00],[0.06,0.26],[0.04,0.60],[0.12,0.84],[0.36,0.92],[0.54,0.76],[0.52,0.56],[0.34,0.42],[0.08,0.50]]] },
  "7": { advance: 0.52, paths: [[[0.04,0.04],[0.52,0.04],[0.22,0.96]]] },
  "8": { advance: 0.56, paths: [[[0.30,0.00],[0.12,0.10],[0.06,0.28],[0.12,0.48],[0.30,0.56],[0.50,0.48],[0.56,0.28],[0.46,0.10],[0.30,0.00]], [[0.30,0.56],[0.10,0.66],[0.04,0.82],[0.12,0.96],[0.32,1.00],[0.50,0.94],[0.56,0.78],[0.46,0.64],[0.30,0.56]]] },
  "9": { advance: 0.56, paths: [[[0.06,0.62],[0.24,0.84],[0.48,0.80],[0.56,0.58],[0.52,0.28],[0.36,0.10],[0.16,0.10],[0.06,0.28],[0.08,0.56],[0.26,0.78],[0.54,0.78],[0.54,1.00]]] },
  "+": { advance: 0.54, paths: [[[0.28,0.15],[0.28,0.80]], [[0.04,0.48],[0.52,0.48]]] },
  "-": { advance: 0.50, paths: [[[0.04,0.50],[0.46,0.50]]] },
  "=": { advance: 0.54, paths: [[[0.04,0.38],[0.50,0.38]], [[0.04,0.60],[0.50,0.60]]] },
  "?": { advance: 0.48, paths: [[[0.10,0.16],[0.20,0.06],[0.38,0.06],[0.48,0.22],[0.46,0.42],[0.28,0.58],[0.26,0.76]], [[0.24,0.90],[0.28,0.94]]] },
  "'": { advance: 0.26, paths: [[[0.12,0.06],[0.16,0.20]]] },
  ",": { advance: 0.28, paths: [[[0.14,0.82],[0.10,1.02]]] },
  ".": { advance: 0.28, paths: [[[0.14,0.90],[0.16,0.94]]] },
  "!": { advance: 0.30, paths: [[[0.16,0.06],[0.18,0.68]], [[0.16,0.86],[0.18,0.90]]] },
  "(": { advance: 0.36, paths: [[[0.28,0.02],[0.14,0.18],[0.06,0.42],[0.06,0.62],[0.16,0.86],[0.30,1.00]]] },
  ")": { advance: 0.36, paths: [[[0.06,0.02],[0.20,0.18],[0.28,0.42],[0.28,0.62],[0.18,0.86],[0.04,1.00]]] },
};
/* eslint-enable key-spacing */

/** Fallback glyph for any character not in the library: a small tilde. */
const UNKNOWN: Glyph = {
  advance: 0.46,
  paths: [[[0.06,0.52],[0.18,0.36],[0.32,0.52],[0.44,0.36]]],
};

// ---------------------------------------------------------------------------
// Tiny seeded RNG – ensures the same phrase+line always renders identically.
// ---------------------------------------------------------------------------
/** Sample a polyline so playback moves the pen instead of jumping between corners. */
function densify(points: [number, number][], step: number): [number, number][] {
  if (points.length < 2) return points;
  const out: [number, number][] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(dist / step));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
  }
  return out;
}

function seededRng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return () => {
    h ^= h << 13;
    h ^= h >> 17;
    h ^= h << 5;
    return (h >>> 0) / 0xffffffff;
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One pen-down path of the teacher note, with its position in the full sequence. */
export interface TeacherStroke {
  points: Point[];
  /** Cumulative count of all points that precede this stroke. */
  startIdx: number;
}

/** The full animation descriptor for a single teacher note. */
export interface TeacherAnim {
  strokes: TeacherStroke[];
  totalPoints: number;
}

// ---------------------------------------------------------------------------
// Build the animation
// ---------------------------------------------------------------------------

/**
 * Convert a short phrase into a sequence of handwriting strokes placed
 * beside (or above) the student ink on `targetLine`.
 *
 * Returns `null` if the phrase is empty or produces no renderable strokes.
 */
export function buildTeacherAnim(
  phrase: string,
  targetLine: number,
  studentStrokes: Stroke[],
  boardW: number,
): TeacherAnim | null {
  const text = phrase.trim().toLowerCase();
  if (!text) return null;

  const rng = seededRng(`${text}|${targetLine}`);

  // Where does student ink on this line end?
  const lineStrokes = studentStrokes.filter((s) => lineOf(s) === targetLine);
  const rightEdge =
    lineStrokes.length > 0 ? Math.max(...lineStrokes.map((s) => s.box.maxX)) : 28;

  const GAP = 20;
  const chars = [...text].map((c) => G[c] ?? UNKNOWN);
  const totalAdvance = chars.reduce((sum, g) => sum + g.advance, 0);

  let scale = CAP_H;
  let x0 = rightEdge + GAP;
  const lineTop = (targetLine - 1) * LINE_H;
  // Beside the work: baseline sits in the writing band of this ruled line.
  let yBase = lineTop + LINE_H * 0.22;

  // If it doesn't fit to the right, shrink it and sit in the upper part of the
  // same line, above where the student typically writes.
  if (x0 + totalAdvance * scale > boardW - 8) {
    x0 = 28;
    const available = boardW - x0 - 8;
    scale = Math.min(CAP_H, available / Math.max(totalAdvance, 0.01));
    yBase = lineTop + 6;
  }

  // Lay out glyphs left to right, applying per-glyph wobble for a hand-drawn feel.
  const result: TeacherStroke[] = [];
  let totalPoints = 0;
  let cx = x0;

  for (const glyph of chars) {
    if (glyph.paths.length === 0) {
      cx += glyph.advance * scale;
      continue;
    }

    // Per-glyph natural variation (stable via seeded RNG)
    const yDrift = (rng() - 0.5) * 2.8; // baseline wanders ± ~1.4 px
    const tilt = (rng() - 0.5) * 0.09; // rotation ± ~5°
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);

    for (const rawPath of glyph.paths) {
      const placed: [number, number][] = rawPath.map(([rx, ry]) => {
        // Rotate around the glyph's baseline point (rx=0, ry=1.0)
        const dy = ry - 1.0;
        const rxt = rx * cosT - dy * sinT;
        const ryt = rx * sinT + dy * cosT + 1.0;
        return [cx + rxt * scale, yBase + yDrift + ryt * scale];
      });
      const samples = densify(placed, 2);
      const n = samples.length;
      const points: Point[] = samples.map(([x, y], i) => {
        // Pressure bell-curve: light entry, press through the middle, taper off.
        const t = n > 1 ? i / (n - 1) : 0.5;
        const pressure = 0.22 + 0.62 * Math.sin(t * Math.PI);
        return [x, y, pressure];
      });

      result.push({ points, startIdx: totalPoints });
      totalPoints += points.length;
    }

    cx += glyph.advance * scale;
  }

  return result.length > 0 ? { strokes: result, totalPoints } : null;
}

// ---------------------------------------------------------------------------
// Draw
// ---------------------------------------------------------------------------

/**
 * Paint the revealed portion of a teacher animation into a 2D canvas context.
 * Call this from the board's draw loop with `revealed` increasing over time.
 */
export function drawTeacherAnim(
  ctx: CanvasRenderingContext2D,
  anim: TeacherAnim,
  revealed: number,
): void {
  if (revealed <= 0) return;

  ctx.fillStyle = "#c62828"; // teacher red

  for (const ts of anim.strokes) {
    const endIdx = revealed - ts.startIdx;
    if (endIdx <= 0) break; // all remaining strokes start later
    const pts = ts.points.slice(0, endIdx);
    if (pts.length < 2) continue;

    const isComplete = endIdx >= ts.points.length;
    // pen: true so width follows the pressure samples instead of a simulated curve.
    ctx.fill(outlinePath(pts, true, isComplete));
  }
}
