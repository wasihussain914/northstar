/**
 * All magic numbers in one place.
 * Adjust these to change the feel of the renderer.
 */

/** Random per-glyph scale range: 1 ± SCALE_JITTER */
export const SCALE_JITTER = 0.04;

/** Max rotation jitter in degrees */
export const ROTATION_JITTER_DEG = 2;

/** Max vertical baseline offset in CSS pixels */
export const VERTICAL_JITTER_PX = 2;

/** Default font height in CSS pixels */
export const DEFAULT_FONT_HEIGHT = 80;

/** Default ink clearance in CSS pixels (minimum gap between ink edges) */
export const DEFAULT_INK_CLEARANCE = 4;

/** Default stroke width in CSS pixels */
export const DEFAULT_STROKE_WIDTH = 2.5;

/** Width of a space character as a fraction of fontHeight */
export const SPACE_WIDTH_FACTOR = 0.38;

/** Resolution of the ink mask in cells per fontHeight */
export const MASK_CELLS_PER_HEIGHT = 32;

/** Extra margin added around ink cells when building the mask (in cells) */
export const MASK_BRUSH_RADIUS_CELLS = 1;

/** Points drawn per animation frame */
export const ANIMATION_POINTS_PER_FRAME = 3;

/** Pause between strokes in ms during animation */
export const ANIMATION_STROKE_PAUSE_MS = 30;
