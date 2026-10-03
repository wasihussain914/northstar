import { useCallback, useEffect, useRef, useState } from "react";
import type { Stroke } from "./board/geometry";
import type { Tutor } from "./useTutor";

export interface Trip {
  /** Distinct mistakes made (stale lines downstream of a fix don't count). */
  wrongTurns: number;
  hintsUsed: number;
  /** Time from first stroke to arriving, in ms; null until arrived. */
  durationMs: number | null;
  steps: number;
}

/** Stats for the current problem, for the end-of-trip summary. */
export function useTrip(strokes: Stroke[], tutor: Tutor) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [arrivedAt, setArrivedAt] = useState<number | null>(null);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [hintsUsed, setHintsUsed] = useState(0);
  // Lines (by content) that were ever on route. If one of those gets flagged
  // later, it's fallout from fixing an earlier line, not a new wrong turn.
  const wasOk = useRef<Set<string>>(new Set());

  const empty = strokes.length === 0;
  useEffect(() => {
    if (empty) {
      setStartedAt(null);
      setArrivedAt(null);
      setFlagged(new Set());
      setHintsUsed(0);
      wasOk.current = new Set();
    } else {
      setStartedAt((t) => t ?? Date.now());
    }
  }, [empty]);

  useEffect(() => {
    for (const [line, m] of tutor.markers) {
      if (m.status === "ok") wasOk.current.add(`${line}|${tutor.lineKeys.get(line)}`);
    }
  }, [tutor.markers, tutor.lineKeys]);

  useEffect(() => {
    const key = tutor.errorKey;
    if (key && !wasOk.current.has(key)) setFlagged((s) => (s.has(key) ? s : new Set(s).add(key)));
  }, [tutor.errorKey]);

  const arrived = !!tutor.result?.arrived && tutor.phase === "ready";
  useEffect(() => {
    setArrivedAt((t) => (arrived ? t ?? Date.now() : null));
  }, [arrived]);

  const countHint = useCallback(() => setHintsUsed((n) => n + 1), []);

  const trip: Trip = {
    wrongTurns: flagged.size,
    hintsUsed,
    durationMs: arrivedAt && startedAt ? arrivedAt - startedAt : null,
    steps: tutor.result?.lines.filter((l) => l.status !== "skip").length ?? 0,
  };
  return { trip, countHint };
}
