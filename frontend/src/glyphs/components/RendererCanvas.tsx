import { useEffect, useRef, useCallback } from "react";
import type { GlyphLibrary } from "../types/handwriting";
import { layoutText, renderText } from "../lib/renderText";
import { drawGlyph, drawGlyphPartialStroke } from "../lib/renderGlyph";
import {
  DEFAULT_FONT_HEIGHT,
  DEFAULT_INK_CLEARANCE,
  DEFAULT_STROKE_WIDTH,
  ANIMATION_POINTS_PER_FRAME,
  ANIMATION_STROKE_PAUSE_MS,
} from "../lib/variation";

const CANVAS_HEIGHT = 500;
const CANVAS_MIN_WIDTH = 1000;

type Props = {
  library: GlyphLibrary | null;
  text: string;
  fontHeight: number;
  inkClearance: number;
  strokeWidth: number;
  seed: number;
  animate: boolean;
  /** Incremented externally to trigger a re-render */
  renderKey: number;
  onLayoutDone: (missing: string[]) => void;
};

export function RendererCanvas({
  library,
  text,
  fontHeight = DEFAULT_FONT_HEIGHT,
  inkClearance = DEFAULT_INK_CLEARANCE,
  strokeWidth = DEFAULT_STROKE_WIDTH,
  seed,
  animate,
  renderKey,
  onLayoutDone,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number | null>(null);

  const clearCanvas = useCallback(
    (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#fbfaf6";
      ctx.fillRect(0, 0, w, h);
    },
    []
  );

  const stopAnimation = useCallback(() => {
    if (animRef.current !== null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !library) return;

    stopAnimation();

    const dpr = window.devicePixelRatio || 1;
    const cssH = CANVAS_HEIGHT;
    const baseline = cssH * 0.65;
    const startX = 40;

    // Compute layout first to determine needed canvas width
    const layoutResult = layoutText(text, library, startX, baseline, {
      fontHeight,
      inkClearance,
      strokeWidthPx: strokeWidth,
      seed,
    });

    layoutResult.glyphs; // used in animation closure below
    onLayoutDone(layoutResult.missingLabels);

    const neededWidth = Math.max(CANVAS_MIN_WIDTH, startX + layoutResult.totalWidth + 60);
    const cssW = neededWidth;

    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    clearCanvas(ctx, cssW, cssH);

    if (!animate) {
      // Render everything at once
      renderText(ctx, text, library, startX, baseline, {
        fontHeight,
        inkClearance,
        strokeWidthPx: strokeWidth,
        seed,
      });
      return;
    }

    // Animation: walk glyph by glyph, stroke by stroke, point by point
    const glyphs = layoutResult.glyphs;
    let gi = 0; // glyph index
    let si = 0; // stroke index within current glyph
    let pi = ANIMATION_POINTS_PER_FRAME; // points revealed so far in current stroke

    function drawAllCompleted(upToGi: number, upToSi: number) {
      if (!ctx) return;
      for (let g = 0; g < upToGi && g < glyphs.length; g++) {
        const layout = glyphs[g];
        if (layout.type === "space" || !layout.glyph) continue;
        if (layout.type === "fallback") {
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
          continue;
        }
        if (g < upToGi - 1) {
          // Fully draw all completed glyphs
          drawGlyph(ctx, layout.glyph, layout.placeX, layout.baseline, layout.drawOpts);
        } else {
          // Current glyph: draw completed strokes only
          for (let s = 0; s < upToSi; s++) {
            drawGlyphPartialStroke(
              ctx,
              layout.glyph,
              layout.placeX,
              layout.baseline,
              layout.drawOpts,
              s,
              layout.glyph.strokes[s]?.length ?? 0
            );
          }
        }
      }
    }

    let lastFrameTime = 0;

    function step(now: number) {
      if (!ctx) return;
      if (gi >= glyphs.length) return;

      // Throttle to ~60fps
      if (now - lastFrameTime < 14) {
        animRef.current = requestAnimationFrame(step);
        return;
      }
      lastFrameTime = now;

      const layout = glyphs[gi];

      if (layout.type === "space" || !layout.glyph || layout.type === "fallback") {
        gi++;
        si = 0;
        pi = ANIMATION_POINTS_PER_FRAME;
        animRef.current = requestAnimationFrame(step);
        return;
      }

      const glyph = layout.glyph;
      const stroke = glyph.strokes[si];

      if (!stroke) {
        // Done with this glyph
        gi++;
        si = 0;
        pi = ANIMATION_POINTS_PER_FRAME;
        setTimeout(() => {
          animRef.current = requestAnimationFrame(step);
        }, ANIMATION_STROKE_PAUSE_MS);
        return;
      }

      // Redraw everything up to now, plus current partial stroke
      const dprNow = window.devicePixelRatio || 1;
      ctx.setTransform(dprNow, 0, 0, dprNow, 0, 0);
      clearCanvas(ctx, cssW, cssH);
      drawAllCompleted(gi + 1, si + 1);
      drawGlyphPartialStroke(ctx, glyph, layout.placeX, layout.baseline, layout.drawOpts, si, pi);

      pi += ANIMATION_POINTS_PER_FRAME;
      if (pi >= stroke.length) {
        si++;
        pi = ANIMATION_POINTS_PER_FRAME;
        if (si >= glyph.strokes.length) {
          gi++;
          si = 0;
          setTimeout(() => {
            animRef.current = requestAnimationFrame(step);
          }, ANIMATION_STROKE_PAUSE_MS);
          return;
        }
      }

      animRef.current = requestAnimationFrame(step);
    }

    animRef.current = requestAnimationFrame(step);

    return () => {
      stopAnimation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library, text, fontHeight, inkClearance, strokeWidth, seed, animate, renderKey]);

  const handleDownloadPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const a = document.createElement("a");
    a.download = "handwriting.png";
    a.href = canvas.toDataURL("image/png");
    a.click();
  };

  const handleDownloadSvg = () => {
    if (!library) return;
    const startX = 40;
    const cssH = CANVAS_HEIGHT;
    const baseline = cssH * 0.65;
    const layoutResult = layoutText(text, library, startX, baseline, {
      fontHeight,
      inkClearance,
      strokeWidthPx: strokeWidth,
      seed,
    });

    const svgW = Math.max(CANVAS_MIN_WIDTH, startX + layoutResult.totalWidth + 60);

    const paths: string[] = [];
    for (const layout of layoutResult.glyphs) {
      if (layout.type === "space" || !layout.glyph) continue;
      if (layout.type === "fallback") {
        const rx = layout.placeX + 1;
        const ry = layout.baseline - layout.scaledHeight + 1;
        const rw = layout.scaledHeight * 0.5 - 2;
        const rh = layout.scaledHeight - 2;
        paths.push(
          `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="#888" stroke-width="1"/>`
        );
        continue;
      }
      const glyph = layout.glyph;
      const scaledHeight = layout.scaledHeight;
      const cx = layout.placeX + (glyph.width * scaledHeight) / 2;
      const cy = layout.baseline + layout.verticalOffset - scaledHeight / 2;

      for (const stroke of glyph.strokes) {
        if (stroke.length === 0) continue;
        const pts = stroke.map((p) => {
          const nx = p.x - glyph.width / 2;
          const ny = p.y - 0.5;
          const sx = nx * scaledHeight;
          const sy = ny * scaledHeight;
          const cosR = Math.cos(layout.rotationRad);
          const sinR = Math.sin(layout.rotationRad);
          return {
            x: cx + sx * cosR - sy * sinR,
            y: cy + sx * sinR + sy * cosR,
          };
        });
        if (pts.length === 1) {
          paths.push(
            `<circle cx="${pts[0].x.toFixed(2)}" cy="${pts[0].y.toFixed(2)}" r="${(strokeWidth / 2).toFixed(2)}" fill="#1a1a1a"/>`
          );
        } else {
          const d =
            `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)} ` +
            pts
              .slice(1)
              .map((pt) => `L ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`)
              .join(" ");
          paths.push(
            `<path d="${d}" fill="none" stroke="#1a1a1a" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
          );
        }
      }
    }

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${cssH}" viewBox="0 0 ${svgW} ${cssH}">
  <rect width="${svgW}" height="${cssH}" fill="#fbfaf6"/>
  ${paths.join("\n  ")}
</svg>`;

    const blob = new Blob([svg], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.download = "handwriting.svg";
    a.href = URL.createObjectURL(blob);
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="renderer-canvas-wrap">
      <div className="canvas-scroll">
        <canvas ref={canvasRef} />
      </div>
      <div className="canvas-actions">
        <button onClick={handleDownloadPng} className="glyph-btn">
          Download PNG
        </button>
        <button onClick={handleDownloadSvg} className="glyph-btn">
          Download SVG
        </button>
      </div>
    </div>
  );
}
