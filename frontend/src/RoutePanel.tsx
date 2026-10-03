import { useEffect, useState } from "react";
import type { CheckResult } from "./api";
import { MarkerIcon } from "./board/Board";
import { MathText } from "./MathText";
import { speakable } from "./speakable";
import type { Trip } from "./useTrip";
import type { Tutor } from "./useTutor";
import { speak } from "./voice";

const HINT_LABELS = ["Hint", "More specific", "Show me the fix"];

interface Props {
  tutor: Tutor;
  problem: string;
  selectedLine: number | null;
  onSelectLine: (line: number) => void;
  voiceOn: boolean;
  trip: Trip;
  /** Last ruled line that currently has student ink. */
  lastInkLine: number | null;
  /** Called when the student requests a hint. Passes the ink phrase and target
   *  line so the board can animate a teacher-pen annotation. */
  onHint: (inkPhrase?: string, inkLine?: number) => void;
  onNewTrip: () => void;
  /** Button label on the trip summary ("New problem", "Next stop · 2 of 4"). */
  nextLabel?: string;
  /** Detour-practice card, shown with the trip summary. */
  practiceCard?: React.ReactNode;
  children?: React.ReactNode;
}

export function RoutePanel({ tutor, problem, selectedLine, onSelectLine, voiceOn, trip, lastInkLine, onHint, onNewTrip, nextLabel, practiceCard, children }: Props) {
  const { result, errorLine, errorKey, phase, failure } = tutor;
  const [hintsShown, setHintsShown] = useState(0);
  const [showNext, setShowNext] = useState(false);

  useEffect(() => setHintsShown(0), [errorKey]);
  useEffect(() => setShowNext(false), [result?.next_step_hint]);

  const reveal = () => {
    const next = Math.min(hintsShown + 1, result?.hints.length ?? 0);
    setHintsShown(next);
    const hintText = result?.hints[next - 1];
    // Use the server's short margin note, or fall back to the first four words
    // of the hint text so the pen always has something to write.
    const inkPhrase =
      result?.hint_ink?.[next - 1] ||
      (hintText ? hintText.split(" ").slice(0, 4).join(" ") : undefined);
    onHint(inkPhrase, errorLine ?? undefined);
    if (voiceOn && hintText) speak(hintText);
  };

  return (
    <aside className="panel">
      <Status
        phase={phase}
        result={result}
        errorLine={errorLine}
        failure={failure}
        wrongTurns={trip.wrongTurns}
        onRetry={tutor.checkNow}
      />

      {trip.durationMs != null && <TripSummary trip={trip} onNewTrip={onNewTrip} nextLabel={nextLabel ?? "New problem"} />}
      {trip.durationMs != null && practiceCard}

      {errorLine != null && result && result.hints.length > 0 && (
        <section className="card hint-card">
          <header>
            <span className="eyebrow amber">Recalculating</span>
            <h3>Wrong turn at line {errorLine}</h3>
          </header>
          <ol className="hints">
            {result.hints.slice(0, hintsShown).map((h, i) => (
              <li key={i} className={i === 2 ? "fix" : ""}>
                <span className="hint-level">{HINT_LABELS[i]}</span>
                <p>{h}</p>
              </li>
            ))}
          </ol>
          {hintsShown < result.hints.length && (
            <button className="btn primary" onClick={reveal}>
              {hintsShown === 0 ? "Give me a hint" : HINT_LABELS[hintsShown]}
            </button>
          )}
        </section>
      )}

      {phase === "empty" && errorLine == null && (
        <section className="card">
          <span className="eyebrow">Next turn</span>
          <p className="next-hint">Start on line 1. Write the first step under the question.</p>
        </section>
      )}

      {errorLine == null && result?.next_step_hint && phase !== "empty" && (
        <section className="card">
          {showNext ? (
            <>
              <span className="eyebrow">Next turn</span>
              <p className="next-hint">{result.next_step_hint}</p>
            </>
          ) : (
            <button
              className="btn ghost wide"
              onClick={() => {
                setShowNext(true);
                const nextHintText = result.next_step_hint;
                // Ink phrase: server-provided short note or first four words of text.
                const inkPhrase =
                  result.next_step_ink ||
                  (nextHintText ? nextHintText.split(" ").slice(0, 4).join(" ") : undefined);
                onHint(inkPhrase, lastInkLine ?? undefined);
                if (voiceOn) speak(nextHintText);
              }}
            >
              Stuck? Where do I go next?
            </button>
          )}
        </section>
      )}

      <Route result={result} problem={problem} errorLine={errorLine} selectedLine={selectedLine} onSelectLine={onSelectLine} />

      {result?.route_note && (
        <section className="card route-note">
          <span className="eyebrow">Shortcut spotted</span>
          <p>{result.route_note}</p>
        </section>
      )}

      {children}
    </aside>
  );
}

function TripSummary({ trip, onNewTrip, nextLabel }: { trip: Trip; onNewTrip: () => void; nextLabel: string }) {
  const secs = Math.round((trip.durationMs ?? 0) / 1000);
  const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  const recap =
    trip.wrongTurns === 0
      ? "No wrong turns. Clean route."
      : `You caught and fixed ${trip.wrongTurns === 1 ? "a wrong turn" : `${trip.wrongTurns} wrong turns`} on the way.`;
  return (
    <section className="card trip">
      <span className="eyebrow gold">Trip summary</span>
      <p className="trip-recap">{recap}</p>
      <dl className="trip-stats">
        <div>
          <dt>Steps</dt>
          <dd>{trip.steps}</dd>
        </div>
        <div>
          <dt>Wrong turns</dt>
          <dd>{trip.wrongTurns}</dd>
        </div>
        <div>
          <dt>Hints</dt>
          <dd>{trip.hintsUsed}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{time}</dd>
        </div>
      </dl>
      <button className="btn primary wide" onClick={onNewTrip}>
        {nextLabel}
      </button>
    </section>
  );
}

function Status({ phase, result, errorLine, failure, wrongTurns, onRetry }: {
  phase: Tutor["phase"];
  result: CheckResult | null;
  errorLine: number | null;
  failure: string | null;
  wrongTurns: number;
  onRetry: () => void;
}) {
  let tone = "idle";
  let title = "Start writing";
  let body = "Work one step per line. I'll follow along and speak up if you take a wrong turn.";

  if (phase === "failed") {
    tone = "fail";
    title = "Lost signal";
    body = failure ?? "Something went wrong.";
  } else if (phase === "checking") {
    tone = "busy";
    title = "Checking your route…";
    body = result?.on_track_message || "Reading your work.";
  } else if (phase === "watching") {
    tone = "busy";
    title = "Watching";
    body = "I'll check as soon as you pause.";
  } else if (result && errorLine != null) {
    tone = "off";
    title = "Off route";
    const later = result.lines.some((l) => l.line > errorLine && l.status !== "skip");
    body = later
      ? `Line ${errorLine} doesn't follow from the line above it, and the lines after it build on that.`
      : `Line ${errorLine} doesn't follow from the line above it.`;
  } else if (result?.arrived) {
    tone = "arrived";
    title = "You've arrived";
    body = wrongTurns > 0
      ? "You found your way back after a wrong turn. That's exactly how it's supposed to work."
      : "Clean route, no wrong turns.";
  } else if (result) {
    tone = "on";
    title = "On route";
    body = result.on_track_message || "Every step so far checks out.";
  }

  return (
    <section className={`status tone-${tone}`}>
      <div className="status-dot" />
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
        {phase === "failed" && (
          <button className="btn small" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    </section>
  );
}

function Route({ result, problem, errorLine, selectedLine, onSelectLine }: {
  result: CheckResult | null;
  problem: string;
  errorLine: number | null;
  selectedLine: number | null;
  onSelectLine: (line: number) => void;
}) {
  const lines = result?.lines.filter((l) => l.status !== "skip") ?? [];
  const arrived = !!result?.arrived;
  const readAloud = () => {
    const parts = [`The problem: ${speakable(problem)}.`];
    for (const l of lines) parts.push(`Line ${l.line}, ${SPOKEN_STATUS[l.status]}: ${speakable(l.latex) || "I couldn't read it"}.`);
    parts.push(arrived ? "You've arrived." : result ? `${eta(result.eta_steps)} to go.` : "");
    speak(parts.join(" "));
  };
  return (
    <section className="card route">
      <div className="route-head">
        <span className="eyebrow">Your route</span>
        {lines.length > 0 && (
          <button className="read-aloud" onClick={readAloud} title="Read my work out loud">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 8v4h3l4 3.5v-11L6 8H3zM13.5 7a4 4 0 010 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Read aloud
          </button>
        )}
      </div>
      <ol className="route-list">
        <li className="route-node start">
          <span className="node-icon star" aria-hidden="true">✦</span>
          <div className="node-body">
            <span className="node-label">Start</span>
            <span className="node-text">{problem || "Problem from the board"}</span>
          </div>
        </li>
        {lines.map((l) => {
          const off = errorLine != null && l.line > errorLine;
          return (
            <li
              key={l.line}
              className={`route-node ${l.status}${off ? " off" : ""}${selectedLine === l.line ? " selected" : ""}`}
            >
              <button className="node-hit" onClick={() => onSelectLine(l.line)} aria-label={`Line ${l.line}`}>
                <MarkerIcon marker={{ status: l.status, source: l.source }} />
                <div className="node-body">
                  <span className="node-label">
                    Line {l.line}
                    {l.status === "ok" && (
                      <span className={`badge ${l.source}`}>{l.source === "verified" ? "verified" : "AI-checked"}</span>
                    )}
                    {l.status === "caution" && <span className="badge caution">check at the end</span>}
                    {l.status === "error" && <span className="badge error">wrong turn</span>}
                    {l.status === "unclear" && <span className="badge unclear">couldn't verify</span>}
                  </span>
                  <span className="node-text">{l.latex ? <MathText latex={l.latex} /> : <em>couldn't read</em>}</span>
                  {(l.status === "caution" || (selectedLine === l.line && l.detail)) && l.detail && (
                    <span className="node-detail">{l.detail}</span>
                  )}
                </div>
              </button>
            </li>
          );
        })}
        <li className={`route-node finish${arrived ? " arrived" : ""}`}>
          <span className="node-icon flag" aria-hidden="true">
            <svg viewBox="0 0 20 20">
              <path d="M5 17V3m0 0h9l-2 3.5 2 3.5H5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </span>
          <div className="node-body">
            <span className="node-label">Destination</span>
            <span className="node-text">
              {arrived ? "Arrived" : result ? eta(result.eta_steps) : "Solve it, one line at a time"}
            </span>
          </div>
        </li>
      </ol>
    </section>
  );
}

const SPOKEN_STATUS: Record<string, string> = {
  ok: "on route",
  error: "wrong turn",
  caution: "careful",
  unclear: "not checked",
  pending: "still checking",
  skip: "skipped",
};

function eta(steps: number): string {
  if (steps <= 0) return "Almost there";
  return `About ${steps} more ${steps === 1 ? "step" : "steps"}`;
}
