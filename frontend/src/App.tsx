import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { health } from "./api";
import { Board, type Tool } from "./board/Board";
import { LINES, lineOf, type Stroke } from "./board/geometry";
import { textToStrokes } from "./board/handwriting";
import { AskCard } from "./AskCard";
import { DEMOS, runDemo } from "./demo";
import { RoutePanel } from "./RoutePanel";
import { TypeBar } from "./TypeBar";
import { useTrip } from "./useTrip";
import { useTutor } from "./useTutor";
import { speechSupported, stopSpeaking, unlockSpeech } from "./voice";

const PRESETS = [
  "Solve 2(x − 3) + 4 = 10",
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
  const [voiceOn, setVoiceOn] = useState(speechSupported);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);

  const tutor = useTutor(strokes, problem, voiceOn);
  const { trip, countHint } = useTrip(strokes, tutor);

  useEffect(() => {
    health().then((h) => setHasKey(h ? h.has_key : null));
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
      problem: setProblem,
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

  const newProblem = (p: string) => {
    setProblem(p);
    dispatch({ type: "clear" });
    setSelectedLine(null);
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
      setProblem,
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

        <label className="destination">
          <span className="destination-label">Problem</span>
          <input
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            placeholder="Type a problem, e.g. Solve 3(x − 2) + 5 = 2x + 9"
            list="presets"
            spellCheck={false}
          />
          <datalist id="presets">
            {PRESETS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>

        <div className="tools" role="toolbar" aria-label="Board tools">
          <ToolButton active={tool === "pen"} onClick={() => setTool("pen")} label="Pen (P)">
            <path d="M4 16l1-4 8.5-8.5a2.1 2.1 0 013 3L8 15l-4 1z" />
          </ToolButton>
          <ToolButton active={tool === "eraser"} onClick={() => setTool("eraser")} label="Eraser (E)">
            <path d="M7.5 16h9M3.8 11.8l7-7a1.8 1.8 0 012.5 0l2.9 2.9a1.8 1.8 0 010 2.5L10 16.4H7.6l-3.8-3.8a.6.6 0 010-.8z" />
          </ToolButton>
          <span className="divider" />
          <ToolButton onClick={() => dispatch({ type: "undo" })} disabled={!past.length} label="Undo (⌘Z)">
            <path d="M7 5L3 9l4 4M3.5 9H12a5 5 0 010 10H9" />
          </ToolButton>
          <ToolButton onClick={() => dispatch({ type: "redo" })} disabled={!future.length} label="Redo (⇧⌘Z)">
            <path d="M13 5l4 4-4 4M16.5 9H8a5 5 0 000 10h3" />
          </ToolButton>
          <ToolButton onClick={() => dispatch({ type: "clear" })} disabled={!strokes.length} label="Clear board">
            <path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" />
          </ToolButton>
          <span className="divider" />
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
        </div>
      </header>

      {hasKey === false && (
        <div className="banner">
          No Anthropic API key on the server yet. Add <code>ANTHROPIC_API_KEY</code> to <code>backend/.env</code> and restart it.
        </div>
      )}

      <main className="workspace">
        <section className="board-area">
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
                  newProblem(p);
                }}
              >
                {p}
              </button>
            ))}
          </div>
          <Board
            strokes={strokes}
            tool={tool}
            markers={tutor.markers}
            errorLine={tutor.errorLine}
            selectedLine={selectedLine}
            onAdd={(stroke) => dispatch({ type: "add", stroke })}
            onErase={(ids) => dispatch({ type: "erase", ids })}
            onSelectLine={onSelectLine}
            onInteract={() => {
              unlockSpeech();
              stopDemo();
            }}
          />
          <TypeBar line={typeTarget} replacing={typeTarget != null && usedLines.has(typeTarget)} onSubmit={typeStep} />
        </section>
        <RoutePanel
          tutor={tutor}
          problem={problem}
          selectedLine={selectedLine}
          onSelectLine={onSelectLine}
          voiceOn={voiceOn}
          trip={trip}
          onHint={countHint}
          onNewTrip={() => newProblem(nextPreset(problem))}
        >
          <AskCard problem={problem} strokes={strokes} result={tutor.result} voiceOn={voiceOn} />
        </RoutePanel>
      </main>
    </div>
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
