import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { health } from "./api";
import { Board, type TeacherInk, type Tool } from "./board/Board";
import { LINES, lineOf, type Stroke } from "./board/geometry";
import { textToStrokes } from "./board/handwriting";
import { AskCard } from "./AskCard";
import { DEMOS, runDemo } from "./demo";
import { DestinationCard } from "./DestinationCard";
import { RecalcBanner, Starburst } from "./Flashes";
import { PlanCard } from "./PlanCard";
import { ProblemScanner, type ScannedProblem } from "./ProblemScanner";
import { RoutePanel } from "./RoutePanel";
import { TypeBar } from "./TypeBar";
import { LANGUAGES, speechLocale, type Lang } from "./i18n";
import { useTrip } from "./useTrip";
import { useTutor } from "./useTutor";
import { setServerTts, setSpeechLang, speechSupported, stopSpeaking, unlockSpeech } from "./voice";

const PRESETS = [
  "Solve 2(x − 3) + 4 = 10",
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
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  // The route drawer slides over the paper; wide desktops dock it (CSS).
  const [panelOpen, setPanelOpen] = useState(false);

  const tutor = useTutor(strokes, problem, voiceOn, lang);
  const { trip, countHint } = useTrip(strokes, tutor);

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

  const handleHint = (inkPhrase?: string, inkLine?: number) => {
    countHint();
    if (inkPhrase && inkLine != null) {
      inkAnchor.current = tutor.lineKeys.get(inkLine) ?? "";
      // New object every time so the board replays the pen stroke.
      setTeacherInk({ phrase: inkPhrase, line: inkLine });
    }
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

  useEffect(() => {
    health().then((h) => {
      setHasKey(h ? h.has_key : null);
      setServerTts(!!h?.tts);
    });
  }, []);

  // Dev helper: window.northstar.write(2, "2x - 6 + 4 = 10") writes a line in a handwriting font.
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { northstar: object }).northstar = {
      write: (line: number, text: string) => dispatch({ type: "addMany", strokes: textToStrokes(text, line) }),
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
      else if (!mod && e.key === "t") {
        e.preventDefault();
        document.getElementById("type-step")?.focus();
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
  const typeStep = (text: string) => {
    if (typeTarget == null) return;
    unlockSpeech();
    stopDemo();
    dispatch({ type: "replaceLine", line: typeTarget, strokes: textToStrokes(text, typeTarget) });
    setSelectedLine(null);
  };

  // Demo autopilot. Touching the board takes back control.
  const tutorRef = useRef(tutor);
  tutorRef.current = tutor;
  const demo = useRef<AbortController | null>(null);
  const [demoRunning, setDemoRunning] = useState(false);
  const stopDemo = () => demo.current?.abort();
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
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 32 32" className="brand-star" aria-hidden="true">
            <path d="M16 2l3.2 10.8L30 16l-10.8 3.2L16 30l-3.2-10.8L2 16l10.8-3.2z" fill="currentColor" />
          </svg>
          <span>North Star</span>
        </div>

        <div className="presets" aria-label="Example problems">
          <button
            className={`chip demo${demoRunning ? " running" : ""}`}
            onClick={demoRunning ? stopDemo : startDemo}
            title="Watch North Star guide a solve, mistakes included"
          >
            {demoRunning ? "■ Stop demo" : "▶ Demo"}
          </button>
          {PRESETS.map((p) => (
            <button
              key={p}
              className={`chip${p === problem ? " active" : ""}`}
              onClick={() => {
                stopDemo();
                clearTrip();
                newProblem(p);
              }}
            >
              {p}
            </button>
          ))}
        </div>

        <div className="topbar-actions">
          <select
            className="lang-pick"
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
          {speechSupported && (
            <ToolButton active={voiceOn} onClick={toggleVoice} label={voiceOn ? "Voice on" : "Voice off"}>
              {voiceOn ? (
                <path d="M3 8v4h3l4 3.5v-11L6 8H3zM13.5 7a4 4 0 010 6M15.5 4.5a7.5 7.5 0 010 11" />
              ) : (
                <path d="M3 8v4h3l4 3.5v-11L6 8H3zM13.5 8l4 4M17.5 8l-4 4" />
              )}
            </ToolButton>
          )}
          <button className="btn primary check-now" onClick={tutor.checkNow} disabled={!strokes.length || tutor.phase === "checking"}>
            Check now
          </button>
          <button
            className={`btn route-toggle${panelOpen ? " active" : ""}`}
            onClick={() => setPanelOpen(!panelOpen)}
            aria-expanded={panelOpen}
          >
            <span className={`route-dot tone-${pillTone(tutor, arrived)}`} />
            Route
          </button>
        </div>
      </header>

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
          />
          <div className="board-stage">
            <StatusPill tutor={tutor} arrived={arrived} onTap={() => setPanelOpen(true)} />
            <RecalcBanner errorKey={tutor.errorKey} line={tutor.errorLine} />
            <Starburst fireKey={arrived ? problem : ""} />
            {strokes.length === 0 && !planDismissed && !demoRunning && (
              <PlanCard
                key={problem}
                problem={problem}
                lang={lang}
                voiceOn={voiceOn}
                onClose={() => setPlanDismissed(true)}
              />
            )}
            <div className="float-tools" role="toolbar" aria-label="Board tools">
              <ToolButton active={tool === "pen"} onClick={() => setTool("pen")} label="Pen (P)">
                <path d="M4 16l1-4 8.5-8.5a2.1 2.1 0 013 3L8 15l-4 1z" />
              </ToolButton>
              <ToolButton active={tool === "eraser"} onClick={() => setTool("eraser")} label="Eraser (E)">
                <path d="M7.5 16h9M3.8 11.8l7-7a1.8 1.8 0 012.5 0l2.9 2.9a1.8 1.8 0 010 2.5L10 16.4H7.6l-3.8-3.8a.6.6 0 010-.8z" />
              </ToolButton>
              <span className="float-divider" />
              <ToolButton onClick={() => dispatch({ type: "undo" })} disabled={!past.length} label="Undo (⌘Z)">
                <path d="M7 5L3 9l4 4M3.5 9H12a5 5 0 010 10H9" />
              </ToolButton>
              <ToolButton onClick={() => dispatch({ type: "redo" })} disabled={!future.length} label="Redo (⇧⌘Z)">
                <path d="M13 5l4 4-4 4M16.5 9H8a5 5 0 000 10h3" />
              </ToolButton>
              <span className="float-divider" />
              <ToolButton onClick={() => dispatch({ type: "clear" })} disabled={!strokes.length} label="Clear board">
                <path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" />
              </ToolButton>
            </div>
            <Board
              strokes={strokes}
              problem={problem}
              promptStart={tutor.phase === "empty"}
              tool={tool}
              markers={tutor.markers}
              errorLine={tutor.errorLine}
              selectedLine={selectedLine}
              teacherInk={teacherInk}
              onAdd={(stroke) => dispatch({ type: "add", stroke })}
              onErase={(ids) => dispatch({ type: "erase", ids })}
              onSelectLine={onSelectLine}
              onInteract={() => {
                unlockSpeech();
                stopDemo();
              }}
            />
          </div>
          <TypeBar line={typeTarget} replacing={typeTarget != null && usedLines.has(typeTarget)} onSubmit={typeStep} />
        </section>
        <div className={`drawer-backdrop${panelOpen ? " open" : ""}`} onClick={() => setPanelOpen(false)} />
        <aside className={`drawer${panelOpen ? " open" : ""}`} aria-label="Route details">
          <header className="drawer-head">
            <span className="eyebrow">Route</span>
            <button className="icon-btn" onClick={() => setPanelOpen(false)} aria-label="Close route panel">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M6 5l8 5-8 5z" fill="currentColor" stroke="none" transform="rotate(90 10 10)" />
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
            onNewTrip={advance}
            nextLabel={hasNextStop ? `Next stop · ${stopIndex + 2} of ${stops.length}` : "New problem"}
          >
            <AskCard problem={problem} strokes={strokes} result={tutor.result} voiceOn={voiceOn} lang={lang} />
          </RoutePanel>
        </aside>
      </main>

      {scanning && <ProblemScanner onUse={useScan} onTrip={useTripScan} onClose={() => setScanning(false)} />}
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

/** The glanceable GPS banner floating on the paper. Tap it for the full route. */
function StatusPill({ tutor, arrived, onTap }: {
  tutor: ReturnType<typeof useTutor>;
  arrived: boolean;
  onTap: () => void;
}) {
  const tone = pillTone(tutor, arrived);
  const label =
    tone === "fail" ? "Lost signal"
    : tone === "busy" ? (tutor.phase === "checking" ? "Checking…" : "Watching")
    : tone === "off" ? `Off route — line ${tutor.errorLine}`
    : tone === "arrived" ? "You have arrived"
    : tone === "on" ? (tutor.result!.eta_steps > 0 ? `On route · ~${tutor.result!.eta_steps} to go` : "On route")
    : tutor.phase === "empty" ? "Start on line 1"
    : "Write one step per line";
  return (
    <button className={`status-pill tone-${tone}`} onClick={onTap} title="Show the route">
      <span className="status-dot" />
      {label}
    </button>
  );
}

function ToolButton({ children, label, active, disabled, onClick }: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`icon-btn${active ? " active" : ""}`} onClick={onClick} disabled={disabled} title={label} aria-label={label} aria-pressed={active}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          {children}
        </g>
      </svg>
    </button>
  );
}
