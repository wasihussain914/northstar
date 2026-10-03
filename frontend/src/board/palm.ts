/** Contacts at least this wide (CSS px) are a palm, not a fingertip or a stylus nib. */
export const PALM_CONTACT_PX = 64;

export interface InkContacts {
  /** Touch pointer ids that must not draw. */
  palms: Set<number>;
  /** Pen pointer ids currently on the canvas. */
  pens: Set<number>;
  /** A stylus has touched the board during this session. */
  penUsed: boolean;
}

export function createInkContacts(): InkContacts {
  return { palms: new Set(), pens: new Set(), penUsed: false };
}

export function isOversizedTouch(pointerType: string, width: number, height: number): boolean {
  return pointerType === "touch" && Math.max(width, height) >= PALM_CONTACT_PX;
}

/**
 * A touch is the palm when it is wide, when a pen is already down, or after a
 * pen has been used. The pen pointer itself is never the palm.
 */
export function isPalmContact(
  contacts: InkContacts,
  pointerType: string,
  width: number,
  height: number,
): boolean {
  if (pointerType !== "touch") return false;
  if (isOversizedTouch(pointerType, width, height)) return true;
  if (contacts.pens.size > 0) return true;
  return contacts.penUsed;
}

/** Record a pointerdown. `preempt` means a pen arrived and any touch stroke in progress is the palm. */
export function notePointerDown(
  contacts: InkContacts,
  pointerId: number,
  pointerType: string,
  width: number,
  height: number,
): { palm: boolean; preempt: boolean } {
  const preempt = pointerType === "pen" && contacts.pens.size === 0;
  if (pointerType === "pen") {
    contacts.pens.add(pointerId);
    contacts.penUsed = true;
  }
  const palm = isPalmContact(contacts, pointerType, width, height);
  if (palm) contacts.palms.add(pointerId);
  return { palm, preempt: preempt && palm === false };
}

/**
 * A touch that started small can spread into a palm. Returns true when this
 * pointer must stop drawing.
 */
export function notePointerMove(
  contacts: InkContacts,
  pointerId: number,
  pointerType: string,
  width: number,
  height: number,
): boolean {
  if (contacts.palms.has(pointerId)) return true;
  if (!isPalmContact(contacts, pointerType, width, height)) return false;
  contacts.palms.add(pointerId);
  return true;
}

export function notePointerUp(contacts: InkContacts, pointerId: number): void {
  contacts.palms.delete(pointerId);
  contacts.pens.delete(pointerId);
}
