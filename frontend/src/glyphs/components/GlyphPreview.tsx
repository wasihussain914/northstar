import { useEffect, useRef } from "react";
import type { NormalizedGlyph } from "../types/handwriting";
import { drawGlyph } from "../lib/renderGlyph";

const PREVIEW_SIZE = 80;

type Props = {
  glyphs: NormalizedGlyph[];
  label: string;
};

export function GlyphPreview({ glyphs, label }: Props) {
  return (
    <div className="glyph-preview-panel">
      <h3 className="glyph-preview-title">
        Variants for <code>{label}</code> ({glyphs.length})
      </h3>
      <div className="glyph-preview-grid">
        {glyphs.map((g) => (
          <GlyphCell key={g.sourceId} glyph={g} />
        ))}
      </div>
    </div>
  );
}

function GlyphCell({ glyph }: { glyph: NormalizedGlyph }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const size = PREVIEW_SIZE;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    // White background
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);

    // Draw glyph centered with a small margin
    const margin = 8;
    const availH = size - margin * 2;
    const fontHeight = Math.min(availH, availH / Math.max(glyph.height, 0.1));
    const glyphW = glyph.width * fontHeight;
    const placeX = (size - glyphW) / 2;
    const baseline = margin + fontHeight;

    drawGlyph(ctx, glyph, placeX, baseline, {
      fontHeight,
      glyphScale: 1,
      rotationRad: 0,
      verticalOffset: 0,
      strokeWidthPx: Math.max(1, fontHeight / 20),
      strokeStyle: "#1a1a1a",
    });

    // Border
    ctx.strokeStyle = "#ddd";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, size, size);
  }, [glyph]);

  return <canvas ref={canvasRef} className="glyph-cell" title={glyph.sourceId} />;
}
