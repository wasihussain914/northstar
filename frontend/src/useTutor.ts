import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkBoard, fetchHints, type CheckResult, type KnownLine, type KnownProblem } from "./api";
import type { Marker } from "./board/Board";
import { lineOf, lineSignatures, snapshot, type Stroke } from "./board/geometry";
import { typedTranscript } from "./board/handwriting";
import { PHRASES, type Lang } from "./i18n";
import { caption, speak } from "./voice";

/** How long the pen must rest before we look at the board. */
const PAUSE_MS = 900;
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
  /** Hints for the current wrong turn are still on their way. */
  hintsLoading: boolean;
  checkNow: () => void;
}

/** A read line, remembered with where its verdict came from. */
type Remembered = KnownLine & { source: "verified" | "ai" };

/** Guidance only a model read produces; kept while SymPy-only checks run. */
type Guidance = Pick<CheckResult, "next_step_hint" | "next_step_ink" | "on_track_message" | "eta_steps">;

let blankPng = "";
/** A 1×1 white PNG for checks where nothing needs reading (the server still wants an image). */
function blankImage(): string {
  if (!blankPng) {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 1, 1);
    blankPng = c.toDataURL("image/png");
  }
  return blankPng;
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
  // Questions written on the board that were already answered: line -> stroke
  // signature at the time, so the server isn't asked again every check.
  const answeredQs = useRef(new Map<number, string>());
  // Lines already read, keyed "line|signature": unchanged ones are sent back
  // as text so the model only reads what's new (and the image is cropped to it).
  const remembered = useRef(new Map<string, Remembered>());
  const knownProblem = useRef<KnownProblem | null>(null);
  const guidance = useRef<Guidance | null>(null);

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
    const all = latest.current.strokes;
    if (all.length === 0) return;
    const signatures = lineSignatures(all);
    const lines = [...signatures.keys()].sort((a, b) => a - b);
    busy.current = true;
    setInFlight(true);
    try {
      const transcript = typedTranscript(all);
      const answered = [...answeredQs.current.entries()]
        .filter(([line, sig]) => signatures.get(line) === sig)
        .map(([line]) => line);

      // What can be sent as text instead of read again.
      const known: Record<number, KnownLine> = {};
      const fresh = new Set<number>();
      for (const l of lines) {
        const k = remembered.current.get(`${l}|${signatures.get(l)}`);
        if (k && transcript?.[l] == null) known[l] = k;
        else fresh.add(l);
      }
      // A model-judged line right under an edit gets re-read: its verdict
      // depends on the line above. (SymPy-verified lines are re-verified anyway.)
      for (let i = 1; i < lines.length; i++) {
        const above = lines[i - 1], here = lines[i];
        if (fresh.has(above) && known[here] && remembered.current.get(`${here}|${signatures.get(here)}`)?.source === "ai") {
          delete known[here];
          fresh.add(here);
        }
      }
      const toRead = lines.filter((l) => known[l] == null && transcript?.[l] == null);
      const image = toRead.length ? snapshot(all.filter((s) => toRead.includes(lineOf(s))))!.image : blankImage();

      const raw = await checkBoard(latest.current.problem, image, lines, transcript,
        latest.current.lang, answered, known, knownProblem.current);

      // Remember what was read (only for lines still on the board).
      const byLine = new Map(raw.lines.map((l) => [l.line, l]));
      const next = new Map<string, Remembered>();
      for (const [l, k] of Object.entries(raw.known ?? {})) {
        const line = Number(l);
        const sig = signatures.get(line);
        if (sig != null) next.set(`${line}|${sig}`, { ...k, source: byLine.get(line)?.source ?? "ai" });
      }
      remembered.current = next;
      if (raw.known_problem?.problem_sympy) knownProblem.current = raw.known_problem;

      // A SymPy-only round carries no fresh guidance: keep the last read's.
      let res = raw;
      if (raw.eta_steps < 0) {
        const g = guidance.current;
        res = g ? { ...raw, ...g, next_step_hint: raw.first_error != null || raw.arrived ? "" : g.next_step_hint,
                    next_step_ink: raw.first_error != null || raw.arrived ? "" : g.next_step_ink }
                : { ...raw, eta_steps: 0 };
        if (raw.arrived) res.eta_steps = 0;
      } else {
        guidance.current = { next_step_hint: raw.next_step_hint, next_step_ink: raw.next_step_ink,
                             on_track_message: raw.on_track_message, eta_steps: raw.eta_steps };
      }
      setResult(res);
      setCheckedSigs(signatures);
      setFailure(null);
      respond(res, signatures);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      busy.current = false;
      setInFlight(false);
      const changed = !sameSigs(signatures, lineSignatures(latest.current.strokes));
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
    // A question written on the paper gets its answer spoken first, once.
    if (res.board_question) {
      const q = res.board_question;
      if (answeredQs.current.get(q.line) !== sigs.get(q.line)) {
        answeredQs.current.set(q.line, sigs.get(q.line) ?? "");
        say(q.answer);
        return; // don't talk over the answer with a nudge this round
      }
    }
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
      answeredQs.current.clear();
      remembered.current.clear();
      knownProblem.current = null;
      guidance.current = null;
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
    remembered.current.clear();
    knownProblem.current = null;
    guidance.current = null;
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

  // The hint ladder arrives after the check, so the "recalculating" voice and
  // the markers never wait on a second model call.
  const [hintPack, setHintPack] = useState<{ key: string; hints: string[]; hint_ink: string[]; spoken_nudge: string; loading: boolean } | null>(null);
  const resultRef = useRef(result);
  resultRef.current = result;
  useEffect(() => {
    const res = resultRef.current;
    if (!errorKey || !res || res.first_error == null) return;
    const key = errorKey;
    const firstError = res.first_error;
    setHintPack((cur) => (cur?.key === key ? cur : { key, hints: [], hint_ink: [], spoken_nudge: "", loading: true }));
    const checked = res.lines.filter((l) => l.status !== "pending");
    fetchHints({
      problem: latest.current.problem,
      lines: checked.map((l) => ({ latex: l.latex, sympy: l.sympy, kind: l.kind,
        ai_verdict: l.source === "ai" && (l.status === "ok" || l.status === "error" || l.status === "unclear") ? l.status : "ok" })),
      line_numbers: checked.map((l) => l.line),
      first_error: firstError,
      known_problem: knownProblem.current,
      lang: latest.current.lang,
    })
      .then((h) => setHintPack((cur) => (cur?.key === key ? { key, ...h, loading: false } : cur)))
      .catch(() => setHintPack((cur) => (cur?.key === key
        ? { key, loading: false, spoken_nudge: "",
            hints: [`Take another look at line ${firstError}. Does it really follow from the line above?`,
                    "Compare it carefully with the previous line."],
            hint_ink: ["compare with above", "check each term"] }
        : cur)));
  }, [errorKey]);

  const withHints = useMemo(() => {
    if (!result || !errorKey || hintPack?.key !== errorKey) return result;
    return { ...result, hints: hintPack.hints, hint_ink: hintPack.hint_ink, spoken_nudge: hintPack.spoken_nudge };
  }, [result, errorKey, hintPack]);
  const hintsLoading = !!errorKey && hintPack?.key === errorKey && hintPack.loading;

  const upToDate = result != null && sameSigs(checkedSigs, sigsNow);
  const phase: Phase =
    strokes.length === 0 ? "empty"
    : inFlight ? "checking"
    : failure ? "failed"
    : upToDate ? "ready"
    : "watching";

  return { phase, result: withHints, errorLine, errorKey, markers, lineKeys: sigsNow, failure, hintsLoading, checkNow: run };
}

function sameSigs(a: Map<number, string>, b: Map<number, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
