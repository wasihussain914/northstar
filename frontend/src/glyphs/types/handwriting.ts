export type Point = {
  x: number;
  y: number;
  t?: number;
  pressure?: number;
};

export type Stroke = Point[];

export type RawSample = {
  id: string;
  label: string;
  type: string;
  strokes: Stroke[];
  canvasWidth: number;
  canvasHeight: number;
  strokeWidth?: number;
  quality?: string;
};

export type NormalizedGlyph = {
  label: string;
  strokes: Stroke[];
  width: number;
  height: number;
  sourceId: string;
};

export type GlyphLibrary = {
  byLabel: Map<string, NormalizedGlyph[]>;
  totalLoaded: number;
  totalSkipped: number;
};
