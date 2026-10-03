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

export type Tool = "pen" | "eraser";

export interface Marker {
  status: LineStatus | "checking";
  source?: "verified" | "ai";
}

interface Props {
  strokes: Stroke[];
  tool: Tool;
  markers: Map<number, Marker>;
  errorLine: number | null;
  selectedLine: number | null;
  onAdd: (s: Stroke) => void;
  onErase: (ids: number[]) => void;
  onSelectLine: (line: number) => void;
  onInteract: () => void;
}

const ERASER_R = 14;

export function Board({ strokes, tool, markers, errorLine, selectedLine, onAdd, onErase, onSelectLine, onInteract }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);

  const live = useRef<{ points: Point[]; pen: boolean } | null>(null);
  const erasing = useRef<Set<number> | null>(null);
  // A finished stroke stays drawn from here until it arrives back in `strokes`.
  const committing = useRef<Stroke | null>(null);
  const penSeen = useRef(false);
  const activePointer = useRef<number | null>(null);
  const eraserPos = useRef<[number, number] | null>(null);
  const frame = useRef(0);

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
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.clearRect(0, 0, boardW, BOARD_H);

    if (errorLine) {
      const y = (errorLine - 1) * LINE_H;
      ctx.fillStyle = "rgba(245, 158, 11, 0.10)";
      ctx.fillRect(0, y, boardW, LINE_H);
      ctx.fillStyle = "rgba(245, 158, 11, 0.85)";
      ctx.fillRect(0, y + 6, 3, LINE_H - 12);
    }
    if (selectedLine && selectedLine !== errorLine) {
      ctx.fillStyle = "rgba(59, 130, 246, 0.07)";
      ctx.fillRect(0, (selectedLine - 1) * LINE_H, boardW, LINE_H);
    }

    ctx.strokeStyle = "#d6deea";
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
      ctx.fillStyle = hidden?.has(s.id) ? "rgba(23, 27, 38, 0.18)" : "#171b26";
      ctx.fill(strokePath(s));
    }
    if (committing.current) {
      if (strokes.includes(committing.current)) committing.current = null;
      else {
        ctx.fillStyle = "#171b26";
        ctx.fill(strokePath(committing.current));
      }
    }
    if (live.current && live.current.points.length) {
      ctx.fillStyle = "#171b26";
      ctx.fill(outlinePath(live.current.points, live.current.pen, false));
    }
    if (eraserPos.current) {
      const [x, y] = eraserPos.current;
      ctx.strokeStyle = "rgba(23, 27, 38, 0.45)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, ERASER_R, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [strokes, width, boardW, scale, errorLine, selectedLine]);

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

  const toPoint = (e: PointerEvent | React.PointerEvent, rect: DOMRect): Point => [
    (e.clientX - rect.left) / scale,
    (e.clientY - rect.top) / scale,
    e.pointerType === "pen" ? Math.max(0.05, e.pressure) : 0.5,
  ];

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    onInteract();
    if (e.pointerType === "pen") penSeen.current = true;
    // Palm rejection: once a stylus has been used, ignore fingers on the board.
    if (e.pointerType === "touch" && penSeen.current) return;
    if (activePointer.current !== null) return;
    e.preventDefault();
    activePointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
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
                <span className="line-no">{line}</span>
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
            <path d="M10 2.5c-3.1 0-5.5 2.4-5.5 5.4 0 4 5.5 9.6 5.5 9.6s5.5-5.6 5.5-9.6c0-3-2.4-5.4-5.5-5.4z" fill="currentColor" />
            <circle cx="10" cy="8" r="2.1" fill="#fff" />
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
