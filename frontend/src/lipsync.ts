/**
 * Text-driven lip-sync for Pip.
 *
 * The browser's speech engine gives no audio to analyse, but it does say which
 * word it's on. So the mouth shape comes from the letter being spoken (a wide
 * "a", a round "o", lips pressed for "m"), the timing from walking through
 * the text at speaking speed (resynced at every word), and, for the neural
 * voice, the openness is scaled by the actual loudness.
 */

export interface Viseme {
  /** 0 = lips together, 1 = wide open. */
  open: number;
  /** Mouth width relative to rest: below 1 is rounded, above 1 is stretched. */
  width: number;
}

const SHAPES: [RegExp, Viseme][] = [
  [/[aáàâäã]/, { open: 1, width: 1.05 }],
  [/[eéèêë]/, { open: 0.7, width: 1.12 }],
  [/[iíìîïy]/, { open: 0.5, width: 1.15 }],
  [/[oóòôöõ]/, { open: 0.85, width: 0.62 }],
  [/[uúùûü]/, { open: 0.6, width: 0.55 }],
  [/w/, { open: 0.35, width: 0.55 }],
  [/[mbp]/, { open: 0, width: 0.95 }],
  [/[fv]/, { open: 0.12, width: 1 }],
  [/[0-9]/, { open: 0.7, width: 1 }],
  [/[a-zñç]/, { open: 0.3, width: 0.95 }],
  [/[=+\-×÷^/<>]/, { open: 0.55, width: 1 }],
];

const PAUSE: Viseme = { open: 0, width: 1 };
const GAP: Viseme = { open: 0.08, width: 1 };

/** The mouth shape for the character at `pos` in `text`. */
export function visemeAt(text: string, pos: number): Viseme {
  const ch = (text[Math.floor(pos)] ?? " ").toLowerCase();
  if (ch === " ") return GAP;
  if (/[.,!?;:…"'()]/.test(ch)) return PAUSE;
  for (const [re, shape] of SHAPES) if (re.test(ch)) return shape;
  // Other scripts (Hindi, Chinese…): open and close in a steady rhythm.
  const code = ch.codePointAt(0) ?? 0;
  return { open: 0.25 + 0.6 * (((code * 7) % 10) / 10), width: 1 };
}

/**
 * How long a character takes to say, relative to a letter. Pauses at
 * punctuation, and symbols and digits are spoken as whole words ("equals",
 * "ten").
 */
export function charWeight(ch: string | undefined): number {
  if (ch === undefined) return 1;
  if (ch === " ") return 1.3;
  if (/[,;:]/.test(ch)) return 5;
  if (/[.!?…]/.test(ch)) return 8;
  if (/[0-9]/.test(ch)) return 2.5;
  if (/[=+\-×÷^/<>]/.test(ch)) return 4;
  return 1;
}

/** Where each word starts, for the karaoke caption. */
export function wordStarts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\S+/g)) out.push(m.index ?? 0);
  return out;
}

export interface MouthGeometry {
  /** The open mouth (dark inside). */
  d: string;
  /** Upper teeth, shown when the mouth is open and stretched. */
  teeth: string;
  showTeeth: boolean;
  tongue: { cy: number; rx: number; ry: number; visible: boolean };
}

/** SVG geometry for a mouth centred at (80, 110) in Pip's 160×200 drawing. */
export function mouthGeometry(open: number, width: number): MouthGeometry {
  const w = 12.5 * width;
  // Rounded vowels (o, u) lift the upper lip too, making an oval instead of a bowl.
  const round = Math.max(0, 1 - width);
  const top = 109 - open * (2.2 + round * 16);
  const bottom = 113 + open * 15;
  const d = `M${80 - w} 110 Q80 ${top} ${80 + w} 110 Q${80 + w * 0.85} ${bottom} 80 ${bottom} Q${80 - w * 0.85} ${bottom} ${80 - w} 110 Z`;
  const tw = w * 0.72;
  const teeth = `M${80 - tw} 110 Q80 ${top + 1} ${80 + tw} 110 L${80 + tw * 0.92} 113 Q80 114 ${80 - tw * 0.92} 113 Z`;
  return {
    d,
    teeth,
    showTeeth: open > 0.35 && width > 0.95,
    tongue: { cy: bottom - 3.4, rx: w * 0.55, ry: 1.5 + open * 2.6, visible: open > 0.3 },
  };
}

/** Pip's big grin when he isn't talking (arrival celebration). */
export const GRIN = mouthGeometry(0.85, 1.1);
