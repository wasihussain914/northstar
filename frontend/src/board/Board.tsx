import { useCallback, useEffect, useRef, useState } from "react";
import type { LineStatus } from "../api";
import {
  BOARD_H,
  LINE_H,
  LINES,
  MIN_BOARD_W,
  hitStrokes,
  makeStroke,
  outlinePath,
  strokePath,
  type Point,
  type Stroke,
} from "./geometry";
import { buildTeacherAnim, drawTeacherAnim, type TeacherAnim } from "./teacherPen";
import { createInkContacts, notePointerDown, notePointerMove, notePointerUp } from "./palm";

export type Tool = "pen" | "eraser";

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
  tool: Tool;
  markers: Map<number, Marker>;
  errorLine: number | null;
  selectedLine: number | null;
  /** When set, animates red teacher handwriting beside that line. */
  teacherInk: TeacherInk | null;
  onAdd: (s: Stroke) => void;
  onErase: (ids: number[]) => void;
  onSelectLine: (line: number) => void;
  onInteract: () => void;
  /** Light or dark page; the canvas redraws its ink in the theme's colours. */
  theme: "light" | "dark";
}

const ERASER_R = 14;
/** Duration of the teacher-pen reveal animation in milliseconds. */
const TEACHER_ANIM_MS = 1100;

export function Board({ strokes, tool, markers, errorLine, selectedLine, teacherInk, onAdd, onErase, onSelectLine, onInteract, theme }: Props) {
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

  // Teacher ink animation state (refs so they don't re-trigger draw useCallback)
  const teacherAnimRef = useRef<TeacherAnim | null>(null);
  const teacherRevealRef = useRef(0);
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

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.round(width * dpr), pxH = Math.round(BOARD_H * scale * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    const ctx = canvas.getContext("2d")!;
    // Ink and rule colours come from the stylesheet, so they follow light/dark mode.
    const css = getComputedStyle(canvas);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const ink = color("--ink");
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.clearRect(0, 0, boardW, BOARD_H);

    if (errorLine) {
      const y = (errorLine - 1) * LINE_H;
      ctx.fillStyle = color("--row-error");
      ctx.fillRect(0, y, boardW, LINE_H);
      ctx.fillStyle = "rgba(255, 162, 76, 0.95)";
      ctx.fillRect(0, y + 6, 3, LINE_H - 12);
    }
    if (selectedLine && selectedLine !== errorLine) {
      ctx.fillStyle = color("--row-selected");
      ctx.fillRect(0, (selectedLine - 1) * LINE_H, boardW, LINE_H);
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

    // Red teacher annotation (drawn after student ink, excluded from snapshots)
    const tAnim = teacherAnimRef.current;
    if (tAnim && teacherRevealRef.current > 0) {
      drawTeacherAnim(ctx, tAnim, teacherRevealRef.current);
    }

    if (eraserPos.current) {
      const [x, y] = eraserPos.current;
      ctx.strokeStyle = color("--eraser");
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, ERASER_R, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [strokes, width, boardW, scale, errorLine, selectedLine, theme]);

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

  // Animate teacher ink whenever the hint changes.
  // We intentionally capture `strokes` and `boardW` at the moment teacherInk
  // is set (i.e. when the student clicked "Give me a hint"), so the note is
  // placed relative to the ink that was on screen at that instant.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    cancelAnimationFrame(teacherRafRef.current);
    if (!teacherInk) {
      teacherAnimRef.current = null;
      teacherRevealRef.current = 0;
      requestDraw();
      return;
    }

    const anim = buildTeacherAnim(teacherInk.phrase, teacherInk.line, strokes, boardW);
    teacherAnimRef.current = anim;
    teacherRevealRef.current = 0;

    if (!anim || anim.totalPoints === 0) {
      requestDraw();
      return;
    }

    const startTime = performance.now();
    const tick = () => {
      const elapsed = performance.now() - startTime;
      const r = Math.min(
        Math.round((elapsed / TEACHER_ANIM_MS) * anim.totalPoints),
        anim.totalPoints,
      );
      teacherRevealRef.current = r;
      requestDraw();
      if (r < anim.totalPoints) {
        teacherRafRef.current = requestAnimationFrame(tick);
      }
    };
    teacherRafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(teacherRafRef.current);
  }, [teacherInk]); // eslint-disable-line react-hooks/exhaustive-deps

  const toPoint = (e: PointerEvent | React.PointerEvent, rect: DOMRect): Point => [
    (e.clientX - rect.left) / scale,
    (e.clientY - rect.top) / scale,
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
      <div className={`board${scale < 0.7 ? " compact" : ""}`} style={{ height: BOARD_H * scale }}>
        <div className="gutter">
          {Array.from({ length: LINES }, (_, i) => i + 1).map((line) => {
            const m = markers.get(line);
            return (
              <button
                key={line}
                className={`gutter-row${selectedLine === line ? " selected" : ""}${m ? ` has-${m.status}` : ""}`}
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
            style={{ width, height: BOARD_H * scale }}
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
