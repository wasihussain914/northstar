import type { ChangeEvent } from "react";
import {
  DEFAULT_FONT_HEIGHT,
  DEFAULT_INK_CLEARANCE,
  DEFAULT_STROKE_WIDTH,
} from "../lib/variation";

type Props = {
  // File
  onFileLoad: (json: unknown) => void;
  // Text
  text: string;
  onTextChange: (t: string) => void;
  // Sliders
  fontHeight: number;
  onFontHeightChange: (v: number) => void;
  inkClearance: number;
  onInkClearanceChange: (v: number) => void;
  strokeWidth: number;
  onStrokeWidthChange: (v: number) => void;
  // Seed
  seed: number;
  onSeedChange: (v: number) => void;
  // Buttons / toggle
  onRandomize: () => void;
  onClear: () => void;
  animate: boolean;
  onAnimateToggle: () => void;
};

export function Controls({
  onFileLoad,
  text,
  onTextChange,
  fontHeight = DEFAULT_FONT_HEIGHT,
  onFontHeightChange,
  inkClearance = DEFAULT_INK_CLEARANCE,
  onInkClearanceChange,
  strokeWidth = DEFAULT_STROKE_WIDTH,
  onStrokeWidthChange,
  seed,
  onSeedChange,
  onRandomize,
  onClear,
  animate,
  onAnimateToggle,
}: Props) {
  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string);
        onFileLoad(json);
      } catch {
        alert("Invalid JSON file.");
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="glyph-controls">
      <div className="control-row">
        <label className="control-label">
          Handwriting JSON
          <input
            type="file"
            accept=".json,application/json"
            onChange={handleFile}
            className="file-input"
          />
        </label>
      </div>

      <div className="control-row">
        <label className="control-label">
          Text
          <input
            type="text"
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            className="text-input"
          />
        </label>
      </div>

      <div className="control-row sliders">
        <label className="control-label">
          Font size&nbsp;<span className="val">{fontHeight}px</span>
          <input
            type="range"
            min={20}
            max={200}
            step={1}
            value={fontHeight}
            onChange={(e) => onFontHeightChange(Number(e.target.value))}
          />
        </label>

        <label className="control-label">
          Ink clearance&nbsp;<span className="val">{inkClearance}px</span>
          <input
            type="range"
            min={0}
            max={40}
            step={0.5}
            value={inkClearance}
            onChange={(e) => onInkClearanceChange(Number(e.target.value))}
          />
        </label>

        <label className="control-label">
          Stroke width&nbsp;<span className="val">{strokeWidth}px</span>
          <input
            type="range"
            min={0.5}
            max={8}
            step={0.25}
            value={strokeWidth}
            onChange={(e) => onStrokeWidthChange(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="control-row">
        <label className="control-label">
          Seed&nbsp;
          <input
            type="number"
            value={seed}
            onChange={(e) => onSeedChange(Number(e.target.value))}
            className="seed-input"
          />
        </label>
      </div>

      <div className="control-row buttons">
        <button onClick={onRandomize} className="glyph-btn">🎲 Randomize</button>
        <button onClick={onClear} className="glyph-btn">✕ Clear</button>
        <button
          onClick={onAnimateToggle}
          className={`glyph-btn ${animate ? "active" : ""}`}
        >
          {animate ? "✏️ Animate ON" : "✏️ Animate OFF"}
        </button>
      </div>
    </div>
  );
}
