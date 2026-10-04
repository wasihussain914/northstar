import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkBoard, type CheckResult } from "./api";
import type { Marker } from "./board/Board";
import { lineSignatures, snapshot, type Stroke } from "./board/geometry";
import { typedTranscript } from "./board/handwriting";
import { PHRASES, type Lang } from "./i18n";
import { caption, speak } from "./voice";

/** How long the pen must rest before we look at the board. */
const PAUSE_MS = 1200;
/** Moving on to a fresh line means the one above is done: check it almost at once. */
const CHECKPOINT_MS = 350;
/** Typed lines carry exact text (no reading involved), so barely wait at all. */
const TYPED_MS = 120;
/** If the wrong line is the last one written, wait this long before speaking up. */
const NUDGE_AFTER_IDLE_MS = 7000;

export type Phase = "empty" | "watching" | "checking" | "ready" | "failed";

export interface Tutor {
  phase: Phase;
  result: CheckResult | null;
  /** First wrong line, only while that line is unchanged since it was checked. */
  errorLine: number | null;
  /** Identifies the current wrong turn so hint progress can reset when it changes. */
  errorKey: string;
  markers: Map<number, Marker>;
  /** line -> signature of the strokes on it now (changes whenever the line is edited). */
  lineKeys: Map<number, string>;
  failure: string | null;
  checkNow: () => void;
}

export function useTutor(strokes: Stroke[], problem: string, voiceOn: boolean, lang: Lang = "en"): Tutor {
  const [result, setResult] = useState<CheckResult | null>(null);
  const [checkedSigs, setCheckedSigs] = useState<Map<number, string>>(new Map());
  const [inFlight, setInFlight] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const latest = useRef({ strokes, problem, voiceOn, lang });
  latest.current = { strokes, problem, voiceOn, lang };
  const busy = useRef(false);
  const again = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const nudgeTimer = useRef<number | undefined>(undefined);
  const voice = useRef({ errorKey: "", hadError: false, arrived: false });

  const sigsNow = useMemo(() => lineSignatures(strokes), [strokes]);

  // With the voice off, the words still appear as a caption (Pip's speech bubble).
  const say = (text: string) => {
    if (latest.current.voiceOn) speak(text);
    else caption(text);
  };

  const run = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (busy.current) {
      again.current = true;
      return;
    }
    const snap = snapshot(latest.current.strokes);
    if (!snap) return;
    busy.current = true;
    setInFlight(true);
    try {
      const transcript = typedTranscript(latest.current.strokes);
      const res = await checkBoard(latest.current.problem, snap.image, snap.lines, transcript,
        latest.current.lang);
      setResult(res);
      setCheckedSigs(snap.signatures);
      setFailure(null);
      respond(res, snap.signatures);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      busy.current = false;
      setInFlight(false);
      const changed = !sameSigs(snap.signatures, lineSignatures(latest.current.strokes));
      if (again.current || changed) {
        again.current = false;
        timer.current = window.setTimeout(run, PAUSE_MS / 2);
      }
    }
  }, []);

  // The GPS voice: quiet while you're working, speaks when you drive past a wrong turn.
  const respond = (res: CheckResult, sigs: Map<number, string>) => {
    window.clearTimeout(nudgeTimer.current);
    const v = voice.current;
    if (res.first_error != null) {
      const key = `${res.first_error}|${sigs.get(res.first_error) ?? ""}`;
      v.hadError = true;
      if (key === v.errorKey) return;
      const drovePast = res.lines.some((l) => l.line > res.first_error! && l.status !== "skip");
      const nudge = res.spoken_nudge || PHRASES[latest.current.lang].recalculating(res.first_error);
      if (drovePast) {
        v.errorKey = key;
        say(nudge);
      } else {
        nudgeTimer.current = window.setTimeout(() => {
          v.errorKey = key;
          say(nudge);
        }, NUDGE_AFTER_IDLE_MS);
      }
      return;
    }
    if (v.hadError) {
      v.hadError = false;
      v.errorKey = "";
      if (!res.arrived) say(PHRASES[latest.current.lang].backOnRoute);
    }
    if (res.arrived && !v.arrived) {
      v.arrived = true;
      say(PHRASES[latest.current.lang].arrived);
    }
  };

  // Look at the board once the pen has rested — or right away at a checkpoint,
  // when the student has just started writing on a line below their work.
  const deepestLine = useRef(0);
  useEffect(() => {
    window.clearTimeout(timer.current);
    window.clearTimeout(nudgeTimer.current);
    if (strokes.length === 0) {
      deepestLine.current = 0;
      setResult(null);
      setCheckedSigs(new Map());
      setFailure(null);
      voice.current = { errorKey: "", hadError: false, arrived: false };
      return;
    }
    const deepest = Math.max(...sigsNow.keys());
    const advanced = deepest > deepestLine.current && deepestLine.current > 0;
    deepestLine.current = deepest;
    const typed = typedTranscript(strokes);
    const allTyped = !!typed && [...sigsNow.keys()].every((l) => typed[l] != null);
    timer.current = window.setTimeout(run, allTyped ? TYPED_MS : advanced ? CHECKPOINT_MS : PAUSE_MS);
    return () => window.clearTimeout(timer.current);
  }, [strokes, problem, run, sigsNow]);

  useEffect(() => {
    voice.current.arrived = false;
  }, [problem]);

  useEffect(() => () => {
    window.clearTimeout(timer.current);
    window.clearTimeout(nudgeTimer.current);
  }, []);

  const markers = useMemo(() => {
    const out = new Map<number, Marker>();
    const byLine = new Map(result?.lines.map((l) => [l.line, l]) ?? []);
    for (const [line, sig] of sigsNow) {
      const checked = byLine.get(line);
      if (checked && checkedSigs.get(line) === sig) out.set(line, { status: checked.status, source: checked.source });
      else out.set(line, { status: inFlight ? "checking" : "pending" });
    }
    return out;
  }, [sigsNow, result, checkedSigs, inFlight]);

  const errorLine =
    result?.first_error != null && checkedSigs.get(result.first_error) === sigsNow.get(result.first_error)
      ? result.first_error
      : null;
  const errorKey = errorLine != null ? `${errorLine}|${sigsNow.get(errorLine)}` : "";

  const upToDate = result != null && sameSigs(checkedSigs, sigsNow);
  const phase: Phase =
    strokes.length === 0 ? "empty"
    : inFlight ? "checking"
    : failure ? "failed"
    : upToDate ? "ready"
    : "watching";

  return { phase, result, errorLine, errorKey, markers, lineKeys: sigsNow, failure, checkNow: run };
}

function sameSigs(a: Map<number, string>, b: Map<number, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
