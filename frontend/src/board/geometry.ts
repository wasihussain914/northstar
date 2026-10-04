import { getStroke } from "perfect-freehand";

/** x, y, pressure — in board coordinates (CSS pixels). */
export type Point = [number, number, number];

export interface Stroke {
  id: number;
  points: Point[];
  /** Drawn with a stylus (real pressure) rather than a mouse or finger. */
  pen: boolean;
  box: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Height of one ruled line. One step of work per line. */
export const LINE_H = 88;
export const LINES = 12;
export const BOARD_H = LINE_H * LINES;
/** Narrowest writing area, in board units; smaller screens scale the board down. */
export const MIN_BOARD_W = 680;

const INK = { size: 3.4, thinning: 0.55, smoothing: 0.55, streamline: 0.45 };

let nextId = 1;

export function makeStroke(points: Point[], pen: boolean): Stroke {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { id: nextId++, points, pen, box: { minX, minY, maxX, maxY } };
}

/** Which ruled line (1-based) a stroke belongs to: the one holding its vertical center. */
export function lineOf(s: Stroke): number {
  const cy = (s.box.minY + s.box.maxY) / 2;
  return Math.min(LINES, Math.max(1, Math.floor(cy / LINE_H) + 1));
}

/** Line number -> stroke ids on it, joined. Used to tell which lines changed. */
export function lineSignatures(strokes: Stroke[]): Map<number, string> {
  const ids = new Map<number, number[]>();
  for (const s of strokes) {
    const l = lineOf(s);
    if (!ids.has(l)) ids.set(l, []);
    ids.get(l)!.push(s.id);
  }
  const out = new Map<number, string>();
  for (const [l, list] of ids) out.set(l, list.join(","));
  return out;
}

const pathCache = new WeakMap<Stroke, Path2D>();

export function strokePath(s: Stroke): Path2D {
  let p = pathCache.get(s);
  if (!p) {
    p = outlinePath(s.points, s.pen, true);
    pathCache.set(s, p);
  }
  return p;
}

export function outlinePath(points: Point[], pen: boolean, last: boolean): Path2D {
  const outline = getStroke(points, { ...INK, simulatePressure: !pen, last });
  const path = new Path2D();
  if (outline.length === 0) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length - 1; i++) {
    const [x0, y0] = outline[i];
    const [x1, y1] = outline[i + 1];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  path.closePath();
  return path;
}

/** Strokes passing within `r` of (x, y). */
export function hitStrokes(strokes: Stroke[], x: number, y: number, r: number): number[] {
  const hits: number[] = [];
  for (const s of strokes) {
    const b = s.box;
    if (x < b.minX - r || x > b.maxX + r || y < b.minY - r || y > b.maxY + r) continue;
    const pts = s.points;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i][0] - x, dy = pts[i][1] - y;
      if (dx * dx + dy * dy <= r * r) {
        hits.push(s.id);
        break;
      }
      if (i > 0 && segDist(pts[i - 1], pts[i], x, y) <= r) {
        hits.push(s.id);
        break;
      }
    }
  }
  return hits;
}

function segDist(a: Point, b: Point, x: number, y: number): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len = vx * vx + vy * vy;
  const t = len ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / len)) : 0;
  const px = a[0] + t * vx - x, py = a[1] + t * vy - y;
  return Math.sqrt(px * px + py * py);
}

export interface Snapshot {
  /** PNG as a data URL. */
  image: string;
  /** Lines that have ink, ascending. */
  lines: number[];
  signatures: Map<number, string>;
}

const LABEL_W = 64;
const EXPORT_SCALE = 1.25;

/**
 * Render the board the way Claude should see it: black ink on white, faint
 * rules, and a blue boxed line number in the margin of every line with ink.
 * Cropped to the written area to keep the image small.
 */
export function snapshot(strokes: Stroke[]): Snapshot | null {
  if (strokes.length === 0) return null;
  const signatures = lineSignatures(strokes);
  const lines = [...signatures.keys()].sort((a, b) => a - b);
  return { image: render(strokes, lines, true, EXPORT_SCALE), lines, signatures };
}

/** The handwriting alone, for the homework write-up: no line numbers, lighter rules, smaller file. */
export function inkImage(strokes: Stroke[]): string | null {
  if (strokes.length === 0) return null;
  const lines = [...lineSignatures(strokes).keys()].sort((a, b) => a - b);
  return render(strokes, lines, false, 1);
}

function render(strokes: Stroke[], lines: number[], labels: boolean, scale: number): string {
  const first = lines[0], last = lines[lines.length - 1];
  const top = (first - 1) * LINE_H;
  const height = (last - first + 1) * LINE_H;
  const maxX = Math.max(...strokes.map((s) => s.box.maxX));
  const margin = labels ? LABEL_W : 20;
  const width = margin + Math.max(labels ? 480 : 320, maxX + 32);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = labels ? "#e3e6ea" : "#eef0f3";
  ctx.lineWidth = 1;
  for (let l = first; l <= last + 1; l++) {
    const y = (l - first) * LINE_H + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (labels) {
    ctx.font = "600 18px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const l of lines) {
      const cy = (l - first) * LINE_H + LINE_H / 2;
      ctx.fillStyle = "#1d4ed8";
      roundRect(ctx, 12, cy - 15, 38, 30, 6);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.fillText(String(l), 31, cy + 1);
    }
  }

  ctx.save();
  ctx.translate(margin, -top);
  ctx.fillStyle = "#111111";
  for (const s of strokes) ctx.fill(strokePath(s));
  ctx.restore();

  return canvas.toDataURL("image/png");
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
