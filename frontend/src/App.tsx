import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { health } from "./api";
import { Board, type TeacherInk, type Tool } from "./board/Board";
import { LINES, lineOf, type Stroke } from "./board/geometry";
// import { textToStrokes } from "./board/handwriting"; // superseded by vector glyph renderer
import { AskCard } from "./AskCard";
import { DEMOS, runDemo } from "./demo";
import { DestinationCard } from "./DestinationCard";
import { RecalcBanner, Starburst } from "./Flashes";
import { PlanCard } from "./PlanCard";
import { ProblemScanner, type ScannedProblem } from "./ProblemScanner";
import { RoutePanel } from "./RoutePanel";
import { TypeBar } from "./TypeBar";
import { UntangledMark } from "./Logo";
import { LANGUAGES, speechLocale, type Lang } from "./i18n";
import { Mascot, type PipMood } from "./Mascot";
import { useTrip } from "./useTrip";
import { useTutor } from "./useTutor";
import { loadDataset } from "./glyphs/lib/loadDataset";
import type { GlyphLibrary } from "./glyphs/types/handwriting";
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
      write: (line: number, text: string) => {
        void line; void text; // textToStrokes removed — use the glyph renderer at #glyphs
      },
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
  const typeStep = (_text: string) => {
    if (typeTarget == null) return;
    unlockSpeech();
    stopDemo();
    // textToStrokes removed — typed steps no longer rasterise a font
    // dispatch({ type: "replaceLine", line: typeTarget, strokes: textToStrokes(text, typeTarget) });
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
    <div className={`app${panelOpen ? " panel-open" : ""}${arrived ? " solved" : ""}`}>
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
              }}
              theme={theme}
            />
          </div>
          <TypeBar line={typeTarget} replacing={typeTarget != null && usedLines.has(typeTarget)} onSubmit={typeStep} />
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
            onNewTrip={advance}
            nextLabel={hasNextStop ? `Next stop · ${stopIndex + 2} of ${stops.length}` : "New problem"}
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
