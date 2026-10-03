import { useState, useCallback, useEffect } from "react";
import { loadDataset } from "./lib/loadDataset";
import type { GlyphLibrary } from "./types/handwriting";
import { Controls } from "./components/Controls";
import { RendererCanvas } from "./components/RendererCanvas";
import { GlyphPreview } from "./components/GlyphPreview";
import {
  DEFAULT_FONT_HEIGHT,
  DEFAULT_INK_CLEARANCE,
  DEFAULT_STROKE_WIDTH,
} from "./lib/variation";
import "./glyphs.css";

const DEFAULT_TEXT = "2x + 5 = 17";

export default function GlyphsApp() {
  const [library, setLibrary] = useState<GlyphLibrary | null>(null);
  const [text, setText] = useState(DEFAULT_TEXT);
  const [fontHeight, setFontHeight] = useState(DEFAULT_FONT_HEIGHT);
  const [inkClearance, setInkClearance] = useState(DEFAULT_INK_CLEARANCE);
  const [strokeWidth, setStrokeWidth] = useState(DEFAULT_STROKE_WIDTH);
  const [seed, setSeed] = useState(42);
  const [animate, setAnimate] = useState(false);
  const [renderKey, setRenderKey] = useState(0);
  const [missingLabels, setMissingLabels] = useState<string[]>([]);
  const [previewLabel, setPreviewLabel] = useState<string>("");

  // Auto-load from backend on mount
  useEffect(() => {
    fetch("/api/samples")
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((json) => {
        const lib = loadDataset(json);
        setLibrary(lib);
        setPreviewLabel(lib.byLabel.size > 0 ? [...lib.byLabel.keys()][0] : "");
        setRenderKey((k) => k + 1);
      })
      .catch(() => { /* backend not running — user can still upload manually */ });
  }, []);

  const handleFileLoad = useCallback((json: unknown) => {
    const lib = loadDataset(json);
    setLibrary(lib);
    setPreviewLabel(lib.byLabel.size > 0 ? [...lib.byLabel.keys()][0] : "");
    setRenderKey((k) => k + 1);
  }, []);

  const handleRandomize = useCallback(() => {
    setSeed(Math.floor(Math.random() * 0xffffffff));
    setRenderKey((k) => k + 1);
  }, []);

  const handleClear = useCallback(() => {
    setText("");
  }, []);

  const handleAnimateToggle = useCallback(() => {
    setAnimate((a) => !a);
    setRenderKey((k) => k + 1);
  }, []);

  const sortedLabels = library ? [...library.byLabel.keys()].sort() : [];

  const previewGlyphs =
    previewLabel && library ? library.byLabel.get(previewLabel) ?? [] : [];

  return (
    <div className="glyphs-root">
      <header className="glyphs-header">
        <h1 className="glyphs-title">Handwriting Glyph Renderer</h1>
        <a href="/" className="back-link">← Untangled</a>
      </header>

      <main className="glyphs-main">
        <Controls
          onFileLoad={handleFileLoad}
          text={text}
          onTextChange={setText}
          fontHeight={fontHeight}
          onFontHeightChange={setFontHeight}
          inkClearance={inkClearance}
          onInkClearanceChange={setInkClearance}
          strokeWidth={strokeWidth}
          onStrokeWidthChange={setStrokeWidth}
          seed={seed}
          onSeedChange={setSeed}
          onRandomize={handleRandomize}
          onClear={handleClear}
          animate={animate}
          onAnimateToggle={handleAnimateToggle}
        />

        {!library && (
          <div className="no-dataset">
            Loading handwriting dataset from backend… if this persists, upload the JSON file manually above.
          </div>
        )}

        <RendererCanvas
          library={library}
          text={text}
          fontHeight={fontHeight}
          inkClearance={inkClearance}
          strokeWidth={strokeWidth}
          seed={seed}
          animate={animate}
          renderKey={renderKey}
          onLayoutDone={setMissingLabels}
        />

        <div className="glyphs-bottom">
          {/* Debug panel */}
          <section className="debug-panel">
            <h2 className="debug-title">Debug</h2>
            {library ? (
              <>
                <p>
                  <strong>Loaded samples:</strong> {library.totalLoaded}{" "}
                  <span className="muted">
                    ({library.totalSkipped} skipped)
                  </span>
                </p>
                <p>
                  <strong>Unique labels:</strong> {library.byLabel.size}
                </p>
                <div className="label-list">
                  {sortedLabels.map((label) => (
                    <button
                      key={label}
                      className={`label-chip ${previewLabel === label ? "active" : ""}`}
                      onClick={() => setPreviewLabel(label)}
                      title={`${library.byLabel.get(label)?.length ?? 0} variants`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {missingLabels.length > 0 && (
                  <div className="missing-panel">
                    <strong>Missing glyphs in current text:</strong>{" "}
                    {missingLabels.map((l) => (
                      <code key={l} className="missing-chip">{l}</code>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="muted">No dataset loaded.</p>
            )}
          </section>

          {/* Glyph preview */}
          {previewGlyphs.length > 0 && (
            <GlyphPreview glyphs={previewGlyphs} label={previewLabel} />
          )}
        </div>
      </main>
    </div>
  );
}
