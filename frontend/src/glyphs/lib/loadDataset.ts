import type { GlyphLibrary, RawSample } from "../types/handwriting";
import { preprocessGlyph } from "./preprocessGlyph";

function isRawSample(v: unknown): v is RawSample {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    typeof o.type === "string" &&
    Array.isArray(o.strokes) &&
    typeof o.canvasWidth === "number" &&
    typeof o.canvasHeight === "number"
  );
}

/** Parse a JSON file and return a GlyphLibrary. */
export function loadDataset(json: unknown): GlyphLibrary {
  let records: unknown[];

  if (Array.isArray(json)) {
    records = json;
  } else if (
    json &&
    typeof json === "object" &&
    Array.isArray((json as Record<string, unknown>).samples)
  ) {
    records = (json as Record<string, unknown>).samples as unknown[];
  } else {
    return { byLabel: new Map(), totalLoaded: 0, totalSkipped: 0 };
  }

  const byLabel = new Map<string, ReturnType<typeof preprocessGlyph>[]>();
  let totalLoaded = 0;
  let totalSkipped = 0;

  for (const record of records) {
    if (!isRawSample(record)) {
      totalSkipped++;
      continue;
    }
    if (record.type !== "glyph") {
      totalSkipped++;
      continue;
    }
    if (record.quality !== "good") {
      totalSkipped++;
      continue;
    }

    const glyph = preprocessGlyph(record);
    if (!glyph) {
      totalSkipped++;
      continue;
    }

    totalLoaded++;
    const list = byLabel.get(glyph.label);
    if (list) {
      list.push(glyph);
    } else {
      byLabel.set(glyph.label, [glyph]);
    }
  }

  // TypeScript: byLabel may contain nulls from the loose push above — they can't
  // actually be null because we check above, but tighten the type explicitly.
  const cleanMap = new Map(
    [...byLabel.entries()].map(([label, glyphs]) => [
      label,
      glyphs.filter((g) => g !== null) as Exclude<typeof glyphs[0], null>[],
    ])
  );

  return { byLabel: cleanMap, totalLoaded, totalSkipped };
}
