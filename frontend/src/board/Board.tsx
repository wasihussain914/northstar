import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LineStatus } from "../api";
import {
  BOARD_H,
  LINE_H,
  LINES,
  MIN_BOARD_W,
  hitStrokes,
  lineOf,
  makeStroke,
  outlinePath,
  strokePath,
  type Point,
  type Stroke,
} from "./geometry";
import { questionStrokes } from "./handwriting";
import { createInkContacts, notePointerDown, notePointerMove, notePointerUp } from "./palm";
import { layoutText, type GlyphLayout } from "../glyphs/lib/renderText";
import { drawGlyph, drawGlyphPartialStroke } from "../glyphs/lib/renderGlyph";
import type { GlyphLibrary } from "../glyphs/types/handwriting";
// animation constants only used by the standalone renderer, not teacher pen

export type Tool = "pen" | "eraser";

/** Circle the handwriting on a flagged line. */
function drawMistakeMark(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  errorLine: number,
  color: string,
) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    if (lineOf(s) !== errorLine) continue;
    minX = Math.min(minX, s.box.minX);
    minY = Math.min(minY, s.box.minY);
    maxX = Math.max(maxX, s.box.maxX);
    maxY = Math.max(maxY, s.box.maxY);
  }
  if (!Number.isFinite(minX)) return;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const rx = Math.max(22, (maxX - minX) / 2 + 16);
  const ry = Math.max(16, (maxY - minY) / 2 + 12);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, -0.05, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export interface Marker {
  status: LineStatus | "checking";
  source?: "verified" | "ai";
}

/** A teacher-pen note to animate on the board. Set to null to clear. */
export interface TeacherInk {
  phrase: string;
  line: number;
}

interface Props {
  strokes: Stroke[];
  /** The problem, written in the band above line 1. Not student work. */
  problem: string;
  /** Highlight line 1 and invite the first step. True while the paper has no student ink. */
  promptStart: boolean;
  tool: Tool;
  markers: Map<number, Marker>;
  errorLine: number | null;
  selectedLine: number | null;
  /** When set, animates red teacher handwriting beside that line using personal glyphs. */
  teacherInk: TeacherInk | null;
  /** Personal glyph dataset — drives the teacher-pen renderer. */
  glyphLibrary: GlyphLibrary | null;
  onAdd: (s: Stroke) => void;
  onErase: (ids: number[]) => void;
  onSelectLine: (line: number) => void;
  onInteract: () => void;
  /** Light or dark page; the canvas redraws its ink in the theme's colours. */
  theme: "light" | "dark";
}

const ERASER_R = 14;
const TEACHER_FONT_HEIGHT = 20;          // smaller so it doesn't crowd the student's work
const TEACHER_FONT_HEIGHT_ABOVE = 16;    // even smaller when placed above the line
const TEACHER_STROKE_WIDTH = 1.4;

/** Stored layout + progress for the animated teacher annotation. */
type TeacherState = {
  glyphs: GlyphLayout[];
  gi: number;            // current glyph index
  si: number;            // current stroke index within glyph
  pi: number;            // points revealed in current stroke
  pointsPerFrame: number; // advances fast enough to finish in ~1 second
};

export function Board({ strokes, problem, promptStart, tool, markers, errorLine, selectedLine, teacherInk, glyphLibrary, onAdd, onErase, onSelectLine, onInteract, theme }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);

  const live = useRef<{ points: Point[]; pen: boolean } | null>(null);
  const erasing = useRef<Set<number> | null>(null);
  // A finished stroke stays drawn from here until it arrives back in `strokes`.
  const committing = useRef<Stroke | null>(null);
  const contacts = useRef(createInkContacts());
  const activePointer = useRef<number | null>(null);
  const eraserPos = useRef<[number, number] | null>(null);
  const frame = useRef(0);

  // Teacher ink animation state (glyph renderer)
  const teacherStateRef = useRef<TeacherState | null>(null);
  const teacherRafRef = useRef(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Board coordinates have a minimum width; narrow screens show the board scaled
  // down rather than cutting lines off, so work looks the same on every device.
  const boardW = Math.max(width, MIN_BOARD_W);
  const scale = width / boardW;
  useEffect(() => {
    const stage = wrapRef.current?.closest(".board-stage");
    if (stage instanceof HTMLElement) stage.style.setProperty("--q-band", `${LINE_H * scale}px`);
  }, [scale]);
  // The question sits in its own band so line 1 stays the first line of work.
  const paperH = BOARD_H + LINE_H;
  const question = useMemo(
    () => questionStrokes(problem, Math.max(200, boardW - 40)),
    [problem, boardW],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.round(width * dpr), pxH = Math.round(paperH * scale * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    const ctx = canvas.getContext("2d")!;
    // Ink and rule colours come from the stylesheet, so they follow light/dark mode.
    const css = getComputedStyle(canvas);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const ink = color("--ink");
    const teacher = color("--teacher");
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.clearRect(0, 0, boardW, paperH);

    ctx.fillStyle = color("--q-band-bg");
    ctx.fillRect(0, 0, boardW, LINE_H);
    ctx.fillStyle = ink;
    for (const s of question) ctx.fill(strokePath(s));
    ctx.strokeStyle = color("--rule-strong");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, LINE_H + 0.5);
    ctx.lineTo(boardW, LINE_H + 0.5);
    ctx.stroke();

    ctx.save();
    ctx.translate(0, LINE_H);

    if (errorLine) {
      const y = (errorLine - 1) * LINE_H;
      ctx.fillStyle = color("--row-error");
      ctx.fillRect(0, y, boardW, LINE_H);
      ctx.fillStyle = color("--amber");
      ctx.fillRect(0, y + 6, 3, LINE_H - 12);
    }
    if (selectedLine && selectedLine !== errorLine) {
      ctx.fillStyle = color("--row-selected");
      ctx.fillRect(0, (selectedLine - 1) * LINE_H, boardW, LINE_H);
    }
    if (promptStart && errorLine !== 1) {
      ctx.fillStyle = color("--row-prompt");
      ctx.fillRect(0, 0, boardW, LINE_H);
      ctx.fillStyle = color("--prompt-bar");
      ctx.fillRect(0, 6, 3, LINE_H - 12);
      ctx.font = '30px "Bradley Hand", "Noteworthy", "Chalkboard SE", cursive';
      ctx.textBaseline = "middle";
      // Leave a little room on the right so the hint never runs under the tools.
      const room = boardW - 36 - 176 / Math.max(scale, 0.01);
      const phrase = ["Write your first step here", "First step"].find((p) => ctx.measureText(p).width <= room);
      if (phrase) {
        ctx.fillStyle = color("--prompt-text");
        ctx.fillText(phrase, 28, LINE_H * 0.5);
      }
      ctx.textBaseline = "alphabetic";
    }

    ctx.strokeStyle = color("--rule");
    ctx.lineWidth = 1;
    for (let l = 1; l < LINES; l++) {
      const y = l * LINE_H + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(boardW, y);
      ctx.stroke();
    }

    const hidden = erasing.current;
    for (const s of strokes) {
      ctx.fillStyle = hidden?.has(s.id) ? color("--ink-ghost") : ink;
      ctx.fill(strokePath(s));
    }
    if (committing.current) {
      if (strokes.includes(committing.current)) committing.current = null;
      else {
        ctx.fillStyle = ink;
        ctx.fill(strokePath(committing.current));
      }
    }
    if (live.current && live.current.points.length) {
      ctx.fillStyle = ink;
      ctx.fill(outlinePath(live.current.points, live.current.pen, false));
    }

    if (errorLine) drawMistakeMark(ctx, strokes, errorLine, teacher);

    // Red teacher annotation — rendered via personal glyph library
    const ts = teacherStateRef.current;
    if (ts && ts.glyphs.length > 0) {
      // Draw all fully-completed glyphs
      for (let g = 0; g < ts.gi && g < ts.glyphs.length; g++) {
        const layout = ts.glyphs[g];
        if (layout.type === "space" || !layout.glyph) continue;
        drawGlyph(ctx, layout.glyph, layout.placeX, layout.baseline, {
          ...layout.drawOpts,
          strokeStyle: teacher,
        });
      }
      // Draw the in-progress glyph partially
      if (ts.gi < ts.glyphs.length) {
        const layout = ts.glyphs[ts.gi];
        if (layout.glyph && layout.type === "glyph") {
          // All strokes before the current one, fully drawn
          for (let s = 0; s < ts.si; s++) {
            drawGlyphPartialStroke(ctx, layout.glyph, layout.placeX, layout.baseline,
              { ...layout.drawOpts, strokeStyle: teacher },
              s, layout.glyph.strokes[s]?.length ?? 0);
          }
          // Current stroke, partially drawn
          drawGlyphPartialStroke(ctx, layout.glyph, layout.placeX, layout.baseline,
            { ...layout.drawOpts, strokeStyle: teacher },
            ts.si, ts.pi);
        }
      }
    }

    if (eraserPos.current) {
      const [x, y] = eraserPos.current;
      ctx.strokeStyle = color("--eraser");
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, ERASER_R, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }, [strokes, question, width, boardW, scale, paperH, errorLine, selectedLine, promptStart, theme]);

  // Scheduled frames must use the newest props, not the ones from when they were scheduled.
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const requestDraw = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => drawRef.current());
  }, []);

  useEffect(() => {
    draw();
  }, [draw]);

  // Animate teacher ink using personal glyph renderer whenever the hint changes.
  useEffect(() => {
    cancelAnimationFrame(teacherRafRef.current);
    teacherStateRef.current = null;
    requestDraw();

    if (!teacherInk || !glyphLibrary) return;

    // Lowercase the phrase — only lowercase glyphs are in the dataset
    const phrase = teacherInk.phrase.toLowerCase();
    const seed = teacherInk.line * 997 + (phrase.charCodeAt(0) || 0);

    // Find the rightmost x of student ink on the target line
    const lineStrokes = strokes.filter((s) => lineOf(s) === teacherInk.line);
    const rightEdge = lineStrokes.length > 0
      ? Math.max(...lineStrokes.map((s) => s.box.maxX))
      : 28;

    const GAP = 14;

    // --- Beside attempt ---
    const baseFontH = TEACHER_FONT_HEIGHT;
    const baseline = (teacherInk.line - 1) * LINE_H + LINE_H * 0.72;
    let startX = rightEdge + GAP;
    let usedFontH = baseFontH;
    let usedBaseline = baseline;

    let result = layoutText(phrase, glyphLibrary, startX, baseline, {
      fontHeight: baseFontH,
      inkClearance: 1,
      strokeWidthPx: TEACHER_STROKE_WIDTH,
      seed,
    });

    // --- If overflow, go above the line with a smaller font ---
    if (startX + result.totalWidth > boardW - 8) {
      startX = 28;
      usedFontH = TEACHER_FONT_HEIGHT_ABOVE;
      usedBaseline = (teacherInk.line - 1) * LINE_H + usedFontH + 2;
      result = layoutText(phrase, glyphLibrary, startX, usedBaseline, {
        fontHeight: usedFontH,
        inkClearance: 1,
        strokeWidthPx: Math.max(0.8, TEACHER_STROKE_WIDTH * (usedFontH / baseFontH)),
        seed,
      });
    }

    if (result.glyphs.length === 0) return;

    // Pre-count total points so we can target exactly ~60 frames (≈1 second)
    let totalPoints = 0;
    for (const layout of result.glyphs) {
      if (layout.type !== "glyph" || !layout.glyph) continue;
      for (const stroke of layout.glyph.strokes) totalPoints += stroke.length;
    }
    const TARGET_FRAMES = 60; // ~1 second at 60 fps
    const pointsPerFrame = Math.max(1, Math.ceil(totalPoints / TARGET_FRAMES));

    teacherStateRef.current = { glyphs: result.glyphs, gi: 0, si: 0, pi: pointsPerFrame, pointsPerFrame };
    requestDraw();

    let lastFrameTime = 0;
    function tick(now: number) {
      const ts = teacherStateRef.current;
      if (!ts) return;
      if (now - lastFrameTime < 14) { teacherRafRef.current = requestAnimationFrame(tick); return; }
      lastFrameTime = now;

      // Advance by pointsPerFrame through the glyph list (no inter-stroke pauses)
      let toAdvance = ts.pointsPerFrame;
      while (toAdvance > 0 && ts.gi < ts.glyphs.length) {
        const layout = ts.glyphs[ts.gi];
        if (layout.type === "space" || !layout.glyph || layout.type === "fallback") {
          ts.gi++; ts.si = 0; ts.pi = ts.pointsPerFrame;
          continue;
        }
        const stroke = layout.glyph.strokes[ts.si];
        if (!stroke) {
          ts.gi++; ts.si = 0; ts.pi = ts.pointsPerFrame;
          continue;
        }
        const remaining = stroke.length - ts.pi;
        if (toAdvance >= remaining) {
          toAdvance -= remaining;
          ts.si++;
          ts.pi = ts.pointsPerFrame;
          if (ts.si >= layout.glyph.strokes.length) {
            ts.gi++; ts.si = 0;
          }
        } else {
          ts.pi += toAdvance;
          toAdvance = 0;
        }
      }

      requestDraw();
      if (ts.gi < ts.glyphs.length) {
        teacherRafRef.current = requestAnimationFrame(tick);
      }
    }

    teacherRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(teacherRafRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teacherInk, glyphLibrary]);

  const toPoint = (e: PointerEvent | React.PointerEvent, rect: DOMRect): Point => [
    (e.clientX - rect.left) / scale,
    (e.clientY - rect.top) / scale - LINE_H,
    e.pointerType === "pen" ? Math.max(0.05, e.pressure) : 0.5,
  ];

  const dropActiveStroke = () => {
    live.current = null;
    erasing.current = null;
    activePointer.current = null;
    eraserPos.current = null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    onInteract();
    const { palm, preempt } = notePointerDown(
      contacts.current,
      e.pointerId,
      e.pointerType,
      e.width,
      e.height,
    );
    // The palm often lands first and would steal the only drawing pointer.
    // When the pencil follows, that touch stroke is discarded and the pen draws.
    if (preempt && activePointer.current !== null && activePointer.current !== e.pointerId) {
      dropActiveStroke();
    }
    if (palm) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Already gone. pointerup still clears the contact when it arrives here.
      }
      return;
    }
    if (activePointer.current !== null) return;
    e.preventDefault();
    activePointer.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone. The stroke still records from the events we have.
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const p = toPoint(e, rect);
    // The question band is not a work line.
    if (p[1] < 0) {
      activePointer.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Capture was already released.
      }
      return;
    }
    // The stylus's eraser end, or the right mouse button, erases.
    const erase = tool === "eraser" || e.button === 5 || e.button === 2;
    if (erase) {
      erasing.current = new Set(hitStrokes(strokes, p[0], p[1], ERASER_R));
      eraserPos.current = [p[0], p[1]];
    } else {
      live.current = { points: [p], pen: e.pointerType === "pen" };
    }
    requestDraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (tool === "eraser" && activePointer.current === null && e.pointerType !== "touch") {
      const p = toPoint(e, rect);
      eraserPos.current = [p[0], p[1]];
      requestDraw();
    }
    if (
      notePointerMove(contacts.current, e.pointerId, e.pointerType, e.width, e.height) &&
      e.pointerId === activePointer.current
    ) {
      // A palm contact often starts small and grows. Drop it before it becomes ink.
      dropActiveStroke();
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Capture was already released.
      }
      requestDraw();
      return;
    }
    if (e.pointerId !== activePointer.current) return;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = toPoint(ev, rect);
      if (erasing.current) {
        for (const id of hitStrokes(strokes, p[0], p[1], ERASER_R)) erasing.current.add(id);
        eraserPos.current = [p[0], p[1]];
      } else if (live.current) {
        live.current.points.push(p);
      }
    }
    requestDraw();
  };

  const finish = (e: React.PointerEvent<HTMLCanvasElement>) => {
    notePointerUp(contacts.current, e.pointerId);
    if (e.pointerId !== activePointer.current) return;
    activePointer.current = null;
    if (erasing.current) {
      const ids = [...erasing.current];
      // Keep them faded until the parent removes them, so they don't flash back.
      if (!ids.length) erasing.current = null;
      else window.setTimeout(() => (erasing.current = null), 0);
      if (e.pointerType !== "mouse" || tool !== "eraser") eraserPos.current = null;
      if (ids.length) onErase(ids);
    } else if (live.current) {
      const { points, pen } = live.current;
      live.current = null;
      if (points.length) {
        const stroke = makeStroke(points, pen);
        committing.current = stroke;
        onAdd(stroke);
      }
    }
    requestDraw();
  };

  const onPointerLeave = () => {
    if (activePointer.current === null && eraserPos.current) {
      eraserPos.current = null;
      requestDraw();
    }
  };

  return (
    <div className="board-scroll">
      <div className={`board${scale < 0.7 ? " compact" : ""}`} style={{ height: paperH * scale }}>
        <div className="gutter">
          <div className="gutter-question" style={{ height: LINE_H * scale }} aria-hidden="true">Q</div>
          {Array.from({ length: LINES }, (_, i) => i + 1).map((line) => {
            const m = markers.get(line);
            return (
              <button
                key={line}
                className={`gutter-row${selectedLine === line ? " selected" : ""}${promptStart && line === 1 ? " prompt" : ""}${m ? ` has-${m.status}` : ""}`}
                style={{ height: LINE_H * scale }}
                onClick={() => m && onSelectLine(line)}
                disabled={!m}
                aria-label={m ? `Line ${line}: ${describe(m)}` : `Line ${line}`}
                title={m ? describe(m) : undefined}
              >
                {m && <MarkerIcon marker={m} />}
              </button>
            );
          })}
        </div>
        <div className="paper" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className={`ink tool-${tool}`}
            style={{ width, height: paperH * scale }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={finish}
            onPointerCancel={finish}
            onPointerLeave={onPointerLeave}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
      </div>
    </div>
  );
}

function describe(m: Marker): string {
  switch (m.status) {
    case "ok":
      return m.source === "verified" ? "On route (verified)" : "On route";
    case "error":
      return "Wrong turn here";
    case "caution":
      return "Careful: this step can add extra solutions";
    case "unclear":
      return "Couldn't check this line";
    case "pending":
      return "Waiting to check";
    case "checking":
      return "Checking…";
    case "skip":
      return "Skipped";
  }
}

export function MarkerIcon({ marker }: { marker: Marker }) {
  switch (marker.status) {
    case "ok":
      return (
        <span className={`marker ok ${marker.source === "verified" ? "verified" : ""}`}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M5 10.5l3.2 3.2L15 6.8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      );
    case "error":
      return (
        <span className="marker error">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M6.5 6.5l7 7M13.5 6.5l-7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </span>
      );
    case "caution":
      return (
        <span className="marker caution">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 3l7.5 13.5h-15z" fill="currentColor" />
            <path d="M10 8v4" stroke="#1b1300" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="10" cy="14.3" r="1" fill="#1b1300" />
          </svg>
        </span>
      );
    case "unclear":
      return <span className="marker unclear">?</span>;
    case "checking":
      return <span className="marker checking" />;
    case "pending":
      return <span className="marker pending" />;
    case "skip":
      return <span className="marker skip">–</span>;
  }
}
