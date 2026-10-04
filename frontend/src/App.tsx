import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { checkBoard, health } from "./api";
import { Board, type TeacherInk, type Tool } from "./board/Board";
import { LINES, inkImage, lineOf, snapshot, type Stroke } from "./board/geometry";
import { exportBoardPdf } from "./exportPdf";
import { HomeworkSheet } from "./HomeworkSheet";
import { sameProblem, useHomework, type HomeworkStep } from "./homework";
// Font-rasterised handwriting: still the working path for typed steps, the
// demo, and the dev helper until the vector glyph renderer can emit strokes.
import { textToStrokes, typedTranscript } from "./board/handwriting";
import { AskCard } from "./AskCard";
import { DEMOS, runDemo, writeLines } from "./demo";
import { glyphStrokes } from "./board/glyphInk";
import { finishWork } from "./api";
import { DestinationCard } from "./DestinationCard";
import { RecalcBanner, Starburst } from "./Flashes";
import { FloatingMic } from "./FloatingMic";
import { PlanCard } from "./PlanCard";
import { ProblemScanner, type ScannedProblem } from "./ProblemScanner";
import { RoutePanel } from "./RoutePanel";
import { TypeBar, type TryVerdict } from "./TypeBar";
import { UntangledMark } from "./Logo";
import { LANGUAGES, PHRASES, speechLocale, type Lang } from "./i18n";
import { Mascot, type PipMood } from "./Mascot";
import { useTrip } from "./useTrip";
import { useTutor } from "./useTutor";
import { loadDataset } from "./glyphs/lib/loadDataset";
import type { GlyphLibrary } from "./glyphs/types/handwriting";
import { caption, prefetchSpeech, setServerTts, setSpeechLang, speak, speechSupported, stopSpeaking, unlockSpeech } from "./voice";

const PRESETS = [
  "Solve x² = 5x",
  "Prove: the distance of a linear code C equals the minimum weight of its nonzero codewords",
  "Differentiate x³ − 3x² + 2x",
  "Solve 3(x + 2) − 5 = 2x + 9",
  "Solve −2x + 4 > 10",
  "Solve x/3 + 1 = 5",
  "Solve x² − 5x + 6 = 0",
  "Simplify 4(2a − 3) − 3(a − 5)",
];

function nextPreset(current: string): string {
  const i = PRESETS.indexOf(current);
  return PRESETS[(i + 1) % PRESETS.length];
}

interface History {
  past: Stroke[][];
  present: Stroke[];
  future: Stroke[][];
}

type Action =
  | { type: "add"; stroke: Stroke }
  | { type: "addMany"; strokes: Stroke[] }
  | { type: "replaceLine"; line: number; strokes: Stroke[] }
  | { type: "erase"; ids: number[] }
  | { type: "clear" }
  | { type: "undo" }
  | { type: "redo" };

function history(state: History, action: Action): History {
  const commit = (present: Stroke[]): History => ({ past: [...state.past, state.present], present, future: [] });
  switch (action.type) {
    case "add":
      return commit([...state.present, action.stroke]);
    case "addMany":
      return commit([...state.present, ...action.strokes]);
    case "replaceLine":
      return commit([...state.present.filter((s) => lineOf(s) !== action.line), ...action.strokes]);
    case "erase": {
      const ids = new Set(action.ids);
      return commit(state.present.filter((s) => !ids.has(s.id)));
    }
    case "clear":
      return state.present.length ? commit([]) : state;
    case "undo":
      if (!state.past.length) return state;
      return { past: state.past.slice(0, -1), present: state.past[state.past.length - 1], future: [state.present, ...state.future] };
    case "redo":
      if (!state.future.length) return state;
      return { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1) };
  }
}

export default function App() {
  const [{ present: strokes, past, future }, dispatch] = useReducer(history, { past: [], present: [], future: [] });
  const [tool, setTool] = useState<Tool>("pen");
  const [problem, setProblem] = useState(PRESETS[0]);
  // Set when the problem came off real homework: the crop and its LaTeX.
  const [scan, setScan] = useState<{ latex: string; image: string | null } | null>(null);
  const [scanning, setScanning] = useState(false);
  // A scanned worksheet becomes a trip: several problems, one route.
  const [stops, setStops] = useState<{ problem: string; latex: string }[]>([]);
  const [stopIndex, setStopIndex] = useState(0);
  const [tripImage, setTripImage] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem("ns-lang");
    return LANGUAGES.some((l) => l.code === saved) ? (saved as Lang) : "en";
  });

  useEffect(() => {
    localStorage.setItem("ns-lang", lang);
    setSpeechLang(speechLocale(lang));
  }, [lang]);
  const [voiceOn, setVoiceOn] = useState(speechSupported);

  // Light or dark: the system setting until you pick one, then your pick (remembered here).
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("tangle-theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* no storage: fall back to the system setting */
    }
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f6f6f4" : "#0a0a0a");
  }, [theme]);
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    try {
      localStorage.setItem("tangle-theme", next);
    } catch {
      /* fine: it just won't be remembered */
    }
  };
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  // The glass panel floats over the page on the left. Open by default where there's room for it.
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1100);
  // Pen-first: on touch devices the type bar stays tucked away until asked for.
  const [typeBarOpen, setTypeBarOpen] = useState(() => !window.matchMedia("(pointer: coarse)").matches);

  const [glyphLibrary, setGlyphLibrary] = useState<GlyphLibrary | null>(null);

  // Auto-load the handwriting dataset from the backend on startup
  useEffect(() => {
    fetch("/api/samples")
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((json) => setGlyphLibrary(loadDataset(json)))
      .catch(() => { /* backend not running yet or no samples — silent */ });
  }, []);

  const handleGlyphFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string);
        setGlyphLibrary(loadDataset(json));
      } catch { /* ignore bad files */ }
    };
    reader.readAsText(file);
  };

  const tutor = useTutor(strokes, problem, voiceOn, lang);
  const { trip, countHint } = useTrip(strokes, tutor);

  // The homework document: solved problems get written up here for the PDF.
  const homework = useHomework();
  const [docOpen, setDocOpen] = useState(false);
  const checkedSteps: HomeworkStep[] =
    tutor.result?.lines
      .filter((l) => l.status !== "skip")
      .map((l) => ({ line: l.line, latex: l.latex, check: l.status === "ok" ? l.source : "unchecked" })) ?? [];
  const filedCurrent = homework.doc.entries.some((e) => sameProblem(e.problem, problem));
  const fileCurrent = useCallback(() => {
    if (!checkedSteps.length) return;
    homework.file({
      problem,
      latex: scan?.latex ?? "",
      scan: scan?.image ?? null,
      steps: checkedSteps,
      ink: inkImage(strokes),
      arrived: !!tutor.result?.arrived,
      wrongTurns: trip.wrongTurns,
      hintsUsed: trip.hintsUsed,
      durationMs: trip.durationMs,
    });
  }, [checkedSteps, homework.file, problem, scan, strokes, tutor.result?.arrived, trip]);

  // Red teacher pen. Not part of undo, and not sent to the tutor.
  // Clears when the wrong turn changes, the problem changes, the board is
  // cleared, or the student edits the line the note sits on.
  const [teacherInk, setTeacherInk] = useState<TeacherInk | null>(null);
  const inkAnchor = useRef("");
  useEffect(() => {
    setTeacherInk(null);
  }, [tutor.errorKey, problem]);
  useEffect(() => {
    setTeacherInk((cur) => {
      if (!cur) return null;
      if (strokes.length === 0) return null;
      const sig = tutor.lineKeys.get(cur.line) ?? "";
      if (sig !== inkAnchor.current) return null;
      return cur;
    });
  }, [strokes, tutor.lineKeys]);

  // The tutor writes back: a red margin note beside a question inked on the board.
  const inkedQuestion = useRef("");
  useEffect(() => {
    const q = tutor.result?.board_question;
    if (!q?.ink) return;
    const sig = tutor.lineKeys.get(q.line) ?? "";
    if (!sig) return; // scratchpad questions have no line on the paper
    const key = `${q.line}|${sig}`;
    if (inkedQuestion.current === key) return;
    inkedQuestion.current = key;
    inkAnchor.current = sig;
    setTeacherInk({ phrase: q.ink, line: q.line });
  }, [tutor.result, tutor.lineKeys]);

  const handleHint = (inkPhrase?: string, inkLine?: number) => {
    countHint();
    if (inkPhrase && inkLine != null) {
      inkAnchor.current = tutor.lineKeys.get(inkLine) ?? "";
      // New object every time so the board replays the pen stroke.
      setTeacherInk({ phrase: inkPhrase, line: inkLine });
    }
  };

  const handleShowFix = (line: number, fixLine: string) => {
    countHint();
    setTeacherInk(null);
    if (!fixLine.trim()) return;
    const next = writeRef.current(fixLine, line);
    if (!next.length) return;
    dispatch({ type: "replaceLine", line, strokes: next });
  };

  // Like a GPS, surface the detail when something needs attention:
  // a wrong turn opens the drawer (hints live there), and so does arriving.
  const arrived = !!tutor.result?.arrived && tutor.phase === "ready";

  // Route preview: ask for the whole plan while the paper is still blank.
  const [planDismissed, setPlanDismissed] = useState(false);
  useEffect(() => {
    if (tutor.errorLine != null) setPanelOpen(true);
  }, [tutor.errorLine != null && tutor.errorKey]);
  useEffect(() => {
    if (arrived) setPanelOpen(true);
  }, [arrived]);

  // Arriving files the solution in the homework (re-arriving after an edit
  // updates it). The demo's solves aren't your homework, so they stay out.
  const fileRef = useRef(fileCurrent);
  fileRef.current = fileCurrent;
  useEffect(() => {
    if (arrived && !demoRunning) fileRef.current();
  }, [arrived, tutor.result]);

  const [serverVoice, setServerVoice] = useState(false);
  useEffect(() => {
    health().then((h) => {
      setHasKey(h ? h.has_key : null);
      setServerTts(!!h?.tts);
      setServerVoice(!!h?.tts);
    });
  }, []);

  // Warm the GPS's stock phrases so "Back on route" doesn't wait on a voice fetch.
  useEffect(() => {
    if (!serverVoice || !voiceOn) return;
    const p = PHRASES[lang];
    prefetchSpeech([p.arrived, p.backOnRoute, ...Array.from({ length: 8 }, (_, i) => p.recalculating(i + 1))]);
  }, [serverVoice, voiceOn, lang]);

  // Dev helper: window.northstar.write(2, "2x - 6 + 4 = 10") writes a line in a handwriting font.
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const glyphLibraryRef = useRef(glyphLibrary);
  glyphLibraryRef.current = glyphLibrary;
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { northstar: object }).northstar = {
      write: (line: number, text: string) => dispatch({ type: "addMany", strokes: writeRef.current(text, line) }),
      finish: () => finishRef.current(),
      erase: (line: number) =>
        dispatch({ type: "erase", ids: strokesRef.current.filter((s) => lineOf(s) === line).map((s) => s.id) }),
      clear: () => dispatch({ type: "clear" }),
      problem: (p: string) => {
        setProblem(p);
        setScan(null);
        setStops([]);
        setStopIndex(0);
        setTripImage(null);
      },
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if (!mod && e.key === "e") setTool("eraser");
      else if (!mod && e.key === "p") setTool("pen");
      else if (!mod && e.key === "h") setTool("scroll");
      else if (!mod && e.key === "t") {
        e.preventDefault();
        setTypeBarOpen(true);
        window.setTimeout(() => document.getElementById("type-step")?.focus(), 50);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleVoice = () => {
    unlockSpeech();
    if (voiceOn) stopSpeaking();
    setVoiceOn(!voiceOn);
  };

  const newProblem = (p: string, s: { latex: string; image: string | null } | null = null) => {
    setProblem(p);
    setScan(s);
    setPlanDismissed(false);
    dispatch({ type: "clear" });
    setSelectedLine(null);
    setPanelOpen(false);
  };

  const clearTrip = () => {
    setStops([]);
    setStopIndex(0);
    setTripImage(null);
  };

  const useScan = ({ problem: p, latex, image }: ScannedProblem) => {
    stopDemo();
    setScanning(false);
    clearTrip();
    newProblem(p, { latex, image });
  };

  const useTripScan = (list: { problem: string; latex: string }[], image: string) => {
    stopDemo();
    setScanning(false);
    setStops(list);
    setStopIndex(0);
    setTripImage(image);
    newProblem(list[0].problem, { latex: list[0].latex, image });
  };

  const goToStop = (i: number) => {
    if (i < 0 || i >= stops.length) return;
    setStopIndex(i);
    newProblem(stops[i].problem, { latex: stops[i].latex, image: tripImage });
  };

  // The trip-summary button: next stop if the trip has one, else a fresh problem.
  const hasNextStop = stops.length > 0 && stopIndex + 1 < stops.length;
  const advance = () => {
    if (hasNextStop) goToStop(stopIndex + 1);
    else {
      clearTrip();
      newProblem(nextPreset(problem));
    }
  };

  // Editing a scanned problem's text drops the stale LaTeX but keeps the snap.
  const editProblem = (p: string) => {
    setProblem(p);
    setScan((s) => (s ? { ...s, latex: "" } : s));
  };

  const onSelectLine = useCallback((line: number) => setSelectedLine((cur) => (cur === line ? null : line)), []);

  // Typed steps go on the selected line (replacing it) or the next empty one.
  const usedLines = new Set(strokes.map(lineOf));
  const lastUsed = usedLines.size ? Math.max(...usedLines) : 0;
  const typeTarget = selectedLine ?? (lastUsed < LINES ? lastUsed + 1 : null);
  // The scratchpad: check a typed step against the board without writing it.
  // When it's right, the student writes it on the paper themself.
  const [tryVerdict, setTryVerdict] = useState<TryVerdict | null>(null);
  const tryStep = async (text: string) => {
    if (typeTarget == null) return;
    unlockSpeech();
    stopDemo();
    setTryVerdict({ phase: "checking", message: "" });
    try {
      const snap = snapshot(strokes);
      const image = snap?.image ?? blankBoardPng();
      const tried = [...(snap?.lines ?? []), typeTarget];
      const transcript = { ...(typedTranscript(strokes) ?? {}), [typeTarget]: text };
      const res = await checkBoard(problem, image, tried, transcript, lang);
      // A question typed here ("how do i fix it?") gets answered, out loud.
      if (res.board_question && res.board_question.line === typeTarget) {
        setTryVerdict({ phase: "answered", message: res.board_question.answer });
        if (voiceOn) speak(res.board_question.answer);
        return;
      }
      const line = res.lines.find((l) => l.line === typeTarget);
      if (line?.status === "ok") {
        setTryVerdict({
          phase: "ok",
          message: line.source === "verified" ? "Proven — write it on the paper." : "Looks right — write it on the paper.",
        });
        if (voiceOn) speak("That works. Write it down.");
      } else if (line?.status === "error") {
        setTryVerdict({ phase: "error", message: res.hints[0] || line.detail || "That step doesn't follow from the line above." });
        if (voiceOn) speak(res.spoken_nudge || "Not quite. Take another look.");
      } else {
        setTryVerdict({ phase: "error", message: "Couldn't check that — try phrasing it as an equation or a short claim." });
      }
    } catch (err) {
      setTryVerdict({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  function blankBoardPng(): string {
    const c = document.createElement("canvas");
    c.width = 480;
    c.height = 240;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }

  // Demo autopilot. Touching the board takes back control.
  const tutorRef = useRef(tutor);
  tutorRef.current = tutor;
  const demo = useRef<AbortController | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const stopDemo = () => demo.current?.abort();

  // Written lines (typed steps, the demo, autopilot) use the loaded
  // handwriting when there is one, else the handwriting font.
  const writeStrokes = useCallback(
    (text: string, line: number) => (glyphLibrary ? glyphStrokes(text, line, glyphLibrary) : textToStrokes(text, line)),
    [glyphLibrary],
  );
  const writeRef = useRef(writeStrokes);
  writeRef.current = writeStrokes;

  // Autopilot: the tutor writes the rest of the solution on the page, in
  // your handwriting, one line at a time. Touching the board stops it.
  const finisher = useRef<AbortController | null>(null);
  const [finishing, setFinishing] = useState(false);
  const stopFinish = () => finisher.current?.abort();
  const finishIt = async () => {
    unlockSpeech();
    stopDemo();
    stopFinish();
    const ctrl = new AbortController();
    finisher.current = ctrl;
    setFinishing(true);
    try {
      // Continue from checked work: if the last line hasn't been read yet, read it first.
      const waitReady = async () => {
        const t = tutorRef.current;
        if (t.phase === "ready" || t.phase === "empty" || t.phase === "failed") return;
        if (t.phase !== "checking") t.checkNow();
        const t0 = Date.now();
        while (Date.now() - t0 < 15000 && !ctrl.signal.aborted) {
          await new Promise((r) => window.setTimeout(r, 100));
          const p = tutorRef.current.phase;
          if (p === "ready" || p === "failed" || p === "empty") return;
        }
      };
      await waitReady();
      if (ctrl.signal.aborted) return;
      const current = strokesRef.current;
      const typed = typedTranscript(current) ?? {};
      const read = tutorRef.current.result?.lines ?? [];
      const lines = read
        .filter((l) => l.status !== "skip" && l.status !== "pending")
        .map((l) => ({ line: l.line, text: typed[l.line] ?? l.latex }));
      const used = new Set(current.map(lineOf));
      const start = (used.size ? Math.max(...used) : 0) + 1;
      if (start > LINES) return;
      const { steps } = await finishWork({ problem, lines, lang });
      if (ctrl.signal.aborted) return;
      const todo = steps.slice(0, LINES - start + 1).map((text, i) => ({ line: start + i, text }));
      await writeLines(todo, {
        add: (s) => dispatch({ type: "addMany", strokes: s }),
        strokesFor: writeRef.current,
        hold: (on) => tutorRef.current.hold(on),
      }, ctrl.signal);
    } catch (err) {
      if (!(err instanceof DOMException)) caption(err instanceof Error ? err.message : "Couldn't finish that one.");
    } finally {
      if (finisher.current === ctrl) {
        finisher.current = null;
        setFinishing(false);
      }
    }
  };
  const finishRef = useRef(finishIt);
  finishRef.current = finishIt;
  const startDemo = () => {
    unlockSpeech();
    stopDemo();
    const ctrl = new AbortController();
    demo.current = ctrl;
    setDemoRunning(true);
    setSelectedLine(null);
    const script = DEMOS.find((d) => d.problem === problem) ?? DEMOS[0];
    runDemo(script, {
      setProblem: (p) => {
        setProblem(p);
        setScan(null);
        clearTrip();
      },
      clear: () => dispatch({ type: "clear" }),
      add: (s) => dispatch({ type: "addMany", strokes: s }),
      strokesFor: writeRef.current,
      hold: (on) => tutorRef.current.hold(on),
      eraseLine: (line) =>
        dispatch({ type: "erase", ids: strokesRef.current.filter((s) => lineOf(s) === line).map((s) => s.id) }),
      state: () => {
        const t = tutorRef.current;
        return { errorLine: t.errorLine, arrived: !!t.result?.arrived && t.phase === "ready", ready: t.phase === "ready" };
      },
    }, ctrl.signal)
      .catch(() => {})
      .finally(() => {
        if (demo.current === ctrl) {
          demo.current = null;
          setDemoRunning(false);
        }
      });
  };

  return (
    <div className={`app${panelOpen ? " panel-open" : ""}${arrived ? " solved" : ""}${docOpen ? " doc-open" : ""}`}>
      <header className="topbar">
        <div className="nav-pill glass">
          <UntangledMark className="brand-star" />
          <span className="brand-name">Untangled</span>
          <span className="nav-sep">/</span>
          <span className="nav-problem">{problem || "A new page"}</span>
        </div>

        <div className="tool-pill glass" role="toolbar" aria-label="Board tools">
          <ToolButton active={tool === "pen"} onClick={() => setTool("pen")} label="Pen (P)">
            <path d="M4 16l1-4 8.5-8.5a2.1 2.1 0 013 3L8 15l-4 1z" />
          </ToolButton>
          <ToolButton active={tool === "eraser"} onClick={() => setTool("eraser")} label="Eraser (E)">
            <path d="M7.5 16h9M3.8 11.8l7-7a1.8 1.8 0 012.5 0l2.9 2.9a1.8 1.8 0 010 2.5L10 16.4H7.6l-3.8-3.8a.6.6 0 010-.8z" />
          </ToolButton>
          <ToolButton active={tool === "scroll"} onClick={() => setTool("scroll")} label="Scroll board (H) — drag to move up or down">
            <path d="M10 2v16M6 6l4-4 4 4M6 14l4 4 4-4" />
          </ToolButton>
          <span className="pill-divider" />
          <ToolButton onClick={() => dispatch({ type: "undo" })} disabled={!past.length} label="Undo (⌘Z)">
            <path d="M7 5L3 9l4 4M3.5 9H12a5 5 0 010 10H9" />
          </ToolButton>
          <ToolButton onClick={() => dispatch({ type: "redo" })} disabled={!future.length} label="Redo (⇧⌘Z)">
            <path d="M13 5l4 4-4 4M16.5 9H8a5 5 0 000 10h3" />
          </ToolButton>
          <span className="pill-divider" />
          <ToolButton onClick={() => dispatch({ type: "clear" })} disabled={!strokes.length} label="Clear board">
            <path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" />
          </ToolButton>
          <span className="pill-divider" />
          <ToolButton
            onClick={() => exportBoardPdf({ problem, strokes, student: homework.doc.student, course: homework.doc.course, library: glyphLibrary })}
            disabled={!strokes.length}
            label="Download this page as a PDF"
          >
            <path d="M10 3v10m-4-4l4 4 4-4M4 16h12" />
          </ToolButton>
          <span className="pill-divider" />
          <ToolButton active={typeBarOpen} onClick={() => setTypeBarOpen(!typeBarOpen)} label="Type steps (T)">
            <path d="M3 6h14v9H3zM5.5 8.5h.01M8.5 8.5h.01M11.5 8.5h.01M14.5 8.5h.01M6 12.5h8" />
          </ToolButton>
        </div>

        <div className="topbar-actions">
          <button
            className="btn glass theme-btn"
            onClick={toggleTheme}
            aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            title={theme === "light" ? "Dark mode" : "Light mode"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {theme === "light" ? (
                <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              ) : (
                <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </g>
              )}
            </svg>
          </button>
          <button
            className={`btn glass${demoRunning ? " active" : ""}`}
            onClick={demoRunning ? stopDemo : startDemo}
            title="Watch Untangled guide a solve, mistakes included"
          >
            {demoRunning ? "Stop demo" : "Demo"}
          </button>
          <button className="btn primary check-now" onClick={tutor.checkNow} disabled={!strokes.length || tutor.phase === "checking"}>
            Check now
          </button>
          <button
            className={`btn glass hw-btn${filedCurrent && arrived ? " filed" : ""}`}
            onClick={() => setDocOpen(true)}
            title="Your solved problems, written up. Export as PDF."
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
            <span className="hw-btn-text">Homework</span>
            {homework.doc.entries.length > 0 && <span className="hw-count">{homework.doc.entries.length}</span>}
          </button>
        </div>
      </header>

      {!panelOpen && (
        <button className="panel-open-btn glass" onClick={() => setPanelOpen(true)}>
          <span className={`route-dot tone-${pillTone(tutor, arrived)}`} />
          Ask Untangled
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12 5l-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {hasKey === false && (
        <div className="banner">
          No API key on the server yet. Add <code>ANTHROPIC_API_KEY</code> or <code>GEMINI_API_KEY</code> to <code>backend/.env</code> and restart it.
        </div>
      )}

      <main className="workspace">
        <section className="board-area">
          <DestinationCard
            problem={problem}
            latex={scan?.latex ?? ""}
            image={scan?.image ?? null}
            stopIndex={stopIndex}
            stopCount={stops.length}
            onJumpStop={goToStop}
            onEdit={editProblem}
            onScan={() => {
              stopDemo();
              setScanning(true);
            }}
            status={<StatusPill tutor={tutor} arrived={arrived} onTap={() => setPanelOpen(true)} />}
          />
          {strokes.length === 0 && !planDismissed && !demoRunning && (
            <PlanCard
              key={problem}
              problem={problem}
              lang={lang}
              voiceOn={voiceOn}
              onClose={() => setPlanDismissed(true)}
            />
          )}
          <div className="board-stage">
            <RecalcBanner errorKey={tutor.errorKey} line={tutor.errorLine} />
            <Starburst fireKey={arrived ? problem : ""} />
            <FloatingMic problem={problem} strokes={strokes} result={tutor.result} voiceOn={voiceOn} lang={lang} />
            {!arrived && (
              <button
                className={`autofill-btn glass${finishing ? " writing" : ""}`}
                onClick={finishing ? stopFinish : finishIt}
                title={finishing ? "Stop writing" : "Write the whole solution on the page, in your handwriting"}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  {finishing ? (
                    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
                  ) : (
                    <path d="M4 20l1.5-5L16 4.5a2.1 2.1 0 013 3L8.5 18 4 20zM13.5 7l3.5 3.5M9 13l2 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  )}
                </svg>
                {finishing ? "Writing… tap to stop" : strokes.length ? "Finish the solution" : "Autofill the solution"}
              </button>
            )}
            <Mascot mood={pipMood(tutor, arrived)} voiceOn={voiceOn} besideDrawer={panelOpen} />
            <Board
              strokes={strokes}
              problem={problem}
              promptStart={tutor.phase === "empty"}
              tool={tool}
              markers={tutor.markers}
              errorLine={tutor.errorLine}
              selectedLine={selectedLine}
              teacherInk={teacherInk}
              glyphLibrary={glyphLibrary}
              onAdd={(stroke) => dispatch({ type: "add", stroke })}
              onErase={(ids) => dispatch({ type: "erase", ids })}
              onSelectLine={onSelectLine}
              onInteract={() => {
                unlockSpeech();
                stopDemo();
                stopFinish();
              }}
              theme={theme}
            />
          </div>
          {typeBarOpen && (
            <TypeBar line={typeTarget} verdict={tryVerdict} onTry={tryStep} />
          )}
        </section>
        <div className={`drawer-backdrop${panelOpen ? " open" : ""}`} onClick={() => setPanelOpen(false)} />
        <aside className={`drawer${panelOpen ? " open" : ""}`} aria-label="Route details">
          <header className="drawer-head">
            <span className="drawer-brand">
              <UntangledMark className="drawer-mark" />
              Untangled
            </span>
            <button className="icon-btn" onClick={() => setPanelOpen(false)} aria-label="Hide panel">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M8 5l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </header>
          <RoutePanel
            tutor={tutor}
            problem={problem}
            selectedLine={selectedLine}
            onSelectLine={onSelectLine}
            voiceOn={voiceOn}
            trip={trip}
            lastInkLine={lastUsed || null}
            onHint={handleHint}
            onShowFix={handleShowFix}
            onFinish={finishIt}
            finishing={finishing}
            onNewTrip={advance}
            nextLabel={hasNextStop ? `Next stop · ${stopIndex + 2} of ${stops.length}` : "New problem"}
            docNote={
              filedCurrent ? (
                <button className="hw-link" onClick={() => setDocOpen(true)}>
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M5 10l3.5 3.5L15 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Filed in your homework · problem {homework.doc.entries.findIndex((e) => sameProblem(e.problem, problem)) + 1}
                </button>
              ) : null
            }
          >
            <AskCard problem={problem} strokes={strokes} result={tutor.result} voiceOn={voiceOn} lang={lang} />

            <section className="panel-section">
              <div className="section-head">
                <span className="eyebrow">Try a problem</span>
              </div>
              <div className="preset-chips">
                {PRESETS.map((p, i) => (
                  <button
                    key={p}
                    className={`chip${p === problem ? " active" : ""}`}
                    onClick={() => {
                      stopDemo();
                      clearTrip();
                      newProblem(p);
                    }}
                  >
                    <span className="chip-n">{String(i + 1).padStart(2, "0")}</span>
                    {p}
                  </button>
                ))}
              </div>
            </section>

            <section className="panel-section settings">
              <label
                className="chip glyph-load"
                title={glyphLibrary ? `Handwriting loaded (${glyphLibrary.byLabel.size} glyphs). Tap to load another.` : "Load a handwriting dataset"}
              >
                {glyphLibrary ? `Handwriting · ${glyphLibrary.byLabel.size}` : "Load handwriting"}
                <input type="file" accept=".json" onChange={handleGlyphFile} hidden />
              </label>
              {speechSupported && (
                <button className={`chip${voiceOn ? " active" : ""}`} onClick={toggleVoice} aria-pressed={voiceOn}>
                  {voiceOn ? "Voice on" : "Voice off"}
                </button>
              )}
              <select
                className="chip lang-pick"
                value={lang}
                onChange={(e) => setLang(e.target.value as Lang)}
                aria-label="Guidance language"
                title="Hints and voice in your language"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </section>
          </RoutePanel>
        </aside>
      </main>

      {scanning && <ProblemScanner onUse={useScan} onTrip={useTripScan} onClose={() => setScanning(false)} />}
      {docOpen && (
        <HomeworkSheet
          homework={homework}
          canFileCurrent={checkedSteps.length > 0}
          filedCurrent={filedCurrent}
          onFileCurrent={fileCurrent}
          onClose={() => setDocOpen(false)}
        />
      )}
    </div>
  );
}

type PillTone = "idle" | "busy" | "on" | "off" | "arrived" | "fail";

function pillTone(tutor: ReturnType<typeof useTutor>, arrived: boolean): PillTone {
  if (tutor.phase === "failed") return "fail";
  if (tutor.phase === "checking" || tutor.phase === "watching") return "busy";
  if (tutor.errorLine != null) return "off";
  if (arrived) return "arrived";
  if (tutor.result && tutor.phase === "ready") return "on";
  return "idle";
}

/** How Pip feels about the route right now. */
function pipMood(tutor: ReturnType<typeof useTutor>, arrived: boolean): PipMood {
  if (tutor.phase === "failed") return "dizzy";
  if (arrived) return "party";
  if (tutor.errorLine != null) return "worried";
  if (tutor.phase === "checking") return "thinking";
  if (tutor.result && tutor.phase === "ready") return "happy";
  // You're writing: he watches the board instead of blanking out between checks.
  if (tutor.phase === "watching") return "watching";
  return "idle";
}

/** The glanceable GPS banner floating on the paper. Tap it for the full route. */
function StatusPill({ tutor, arrived, onTap }: {
  tutor: ReturnType<typeof useTutor>;
  arrived: boolean;
  onTap: () => void;
}) {
  const tone = pillTone(tutor, arrived);
  const label =
    tone === "fail" ? "Couldn't check that"
    : tone === "busy" ? (tutor.phase === "checking" ? "Checking…" : "Keep writing")
    : tone === "off" ? `Take another look at line ${tutor.errorLine}`
    : tone === "arrived" ? "Solved"
    : tone === "on" ? (tutor.result!.eta_steps > 0 ? `Looks right · about ${tutor.result!.eta_steps} more` : "Looks right so far")
    : tutor.phase === "empty" ? "Start on line 1"
    : "Write one step per line";
  return (
    <button className={`status-pill tone-${tone}`} onClick={onTap} title="Show the route">
      <span className="status-dot" />
      {label}
    </button>
  );
}

function ToolButton({ children, label, text, active, disabled, onClick }: {
  children: React.ReactNode;
  label: string;
  /** A visible word under the icon, so nobody has to guess what it does. */
  text?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`icon-btn${active ? " active" : ""}${text ? " with-text" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {children}
        </g>
      </svg>
      {text && <span className="tool-text">{text}</span>}
    </button>
  );
}
