import { useEffect, useState } from "react";
import type { Homework, HomeworkEntry } from "./homework";
import { MathText } from "./MathText";

interface Props {
  homework: Homework;
  /** There's checked work on the board right now that could be filed. */
  canFileCurrent: boolean;
  /** The board's problem already has a write-up in the doc. */
  filedCurrent: boolean;
  onFileCurrent: () => void;
  onClose: () => void;
}

/**
 * Your homework, as a sheet of paper: each solved problem written up with the
 * steps you took (and, if you like, your actual handwriting). Export it as a
 * PDF with the browser's print dialog.
 */
export function HomeworkSheet({ homework, canFileCurrent, filedCurrent, onFileCurrent, onClose }: Props) {
  const { doc, update, remove, move, setMeta, clear } = homework;
  const [showInk, setShowInk] = useState(() => localStorage.getItem("ns-hw-ink") !== "0");
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    localStorage.setItem("ns-hw-ink", showInk ? "1" : "0");
  }, [showInk]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        exportPdf();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!confirmClear) return;
    const t = window.setTimeout(() => setConfirmClear(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirmClear]);

  // The print dialog's "Save as PDF" names the file after the page title.
  const exportPdf = () => {
    const was = document.title;
    document.title = [doc.title || "Homework", doc.student].filter(Boolean).join(" - ");
    const restore = () => {
      document.title = was;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  };

  const n = doc.entries.length;
  const solved = doc.entries.filter((e) => e.arrived).length;
  const allVerified = doc.entries.every((e) => e.steps.every((s) => s.check === "verified"));
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="hw-backdrop" onClick={onClose} role="dialog" aria-label="Homework">
      <div className="hw-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="hw-toolbar no-print">
          <div className="hw-toolbar-title">
            <h2>Homework</h2>
            <span className="hw-toolbar-sub">
              {n === 0 ? "Nothing filed yet" : `${n} ${n === 1 ? "problem" : "problems"} · ${solved} solved`}
            </span>
          </div>
          <div className="hw-toolbar-actions">
            <label className={`chip${showInk ? " active" : ""}`} title="Print your handwriting under each write-up">
              <input type="checkbox" checked={showInk} onChange={(e) => setShowInk(e.target.checked)} hidden />
              {showInk ? "Handwriting on" : "Handwriting off"}
            </label>
            {n > 0 && (
              <button className="chip" onClick={() => (confirmClear ? (clear(), setConfirmClear(false)) : setConfirmClear(true))}>
                {confirmClear ? "Really clear all?" : "Clear all"}
              </button>
            )}
            <button className="btn primary" onClick={exportPdf} disabled={n === 0} title="Save as PDF (⌘P)">
              Export PDF
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        {canFileCurrent && !filedCurrent && (
          <div className="hw-file-bar no-print">
            <span>The work on the board isn't in here yet.</span>
            <button className="btn small" onClick={onFileCurrent}>
              Add it as is
            </button>
          </div>
        )}

        <article className="hw-paper">
          <header className="hw-head">
            <input
              className="hw-field hw-title"
              value={doc.title}
              onChange={(e) => setMeta({ title: e.target.value })}
              placeholder="Homework"
              aria-label="Title"
              spellCheck={false}
            />
            <div className="hw-meta">
              <input
                className="hw-field"
                value={doc.student}
                onChange={(e) => setMeta({ student: e.target.value })}
                placeholder="Your name"
                aria-label="Your name"
              />
              <input
                className="hw-field"
                value={doc.course}
                onChange={(e) => setMeta({ course: e.target.value })}
                placeholder="Course"
                aria-label="Course"
              />
              <span className="hw-date">{today}</span>
            </div>
          </header>

          {n === 0 ? (
            <div className="hw-empty">
              <p>Solve a problem on the board and it lands here, written up step by step.</p>
              <p className="hw-empty-sub">Scan a worksheet to work through it stop by stop, or type a problem into the destination card.</p>
            </div>
          ) : (
            <ol className="hw-list">
              {doc.entries.map((e, i) => (
                <Problem
                  key={e.id}
                  n={i + 1}
                  entry={e}
                  showInk={showInk}
                  first={i === 0}
                  last={i === n - 1}
                  onNote={(note) => update(e.id, { note })}
                  onRemove={() => remove(e.id)}
                  onMove={(d) => move(e.id, d)}
                />
              ))}
            </ol>
          )}

          {n > 0 && (
            <footer className="hw-foot">
              Worked step by step with Untangled.{" "}
              {allVerified ? "Every step was verified algebraically." : "Steps marked ✓ were verified algebraically."}
            </footer>
          )}
        </article>
      </div>
    </div>
  );
}

/**
 * Typeset the problem: the instruction word stays as text ("Solve"), the rest
 * is math. Scanned problems already carry LaTeX; typed ones are plain text,
 * which KaTeX reads fine once the unicode operators are translated.
 */
function problemMath(problem: string, latex: string): { verb: string; latex: string } {
  const m = problem.match(/^([A-Za-z][A-Za-z ]*?)[:\s]+(.+)$/s);
  const verb = m ? m[1].trim() : "";
  if (latex) return { verb, latex };
  const rest = (m ? m[2] : problem).trim();
  // Only typeset when it looks like math (has an operator or a variable next to a digit).
  if (!/[=<>+\-−×÷/^²³]/.test(rest) || /[a-zA-Z]{4,}/.test(rest)) return { verb: "", latex: "" };
  const tex = rest
    .replace(/−|–/g, "-")
    .replace(/×|·/g, "\\cdot ")
    .replace(/÷/g, "\\div ")
    .replace(/≤/g, "\\le ")
    .replace(/≥/g, "\\ge ")
    .replace(/≠/g, "\\ne ")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/\^(\d+)/g, "^{$1}")
    .replace(/(\b[\w()]+)\/(\w+)/g, "\\frac{$1}{$2}")
    .replace(/\bsqrt\(([^()]*)\)/g, "\\sqrt{$1}")
    .replace(/\bpi\b/g, "\\pi ");
  return { verb, latex: tex };
}

function Problem({ n, entry, showInk, first, last, onNote, onRemove, onMove }: {
  n: number;
  entry: HomeworkEntry;
  showInk: boolean;
  first: boolean;
  last: boolean;
  onNote: (note: string) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const { verb, latex } = problemMath(entry.problem, entry.latex);
  const steps = entry.steps;
  return (
    <li className={`hw-problem${entry.arrived ? "" : " unfinished"}`}>
      <div className="hw-problem-head">
        <span className="hw-n">{n}.</span>
        <div className="hw-q">
          {latex ? (
            <>
              {verb && <span className="hw-verb">{verb}</span>}
              <MathText latex={latex} />
            </>
          ) : (
            entry.problem
          )}
        </div>
        <div className="hw-problem-actions no-print">
          <button className="icon-btn" onClick={() => onMove(-1)} disabled={first} aria-label="Move up" title="Move up">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 15V5m-4 4l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="icon-btn" onClick={() => onMove(1)} disabled={last} aria-label="Move down" title="Move down">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 5v10m-4-4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="icon-btn" onClick={onRemove} aria-label="Remove from homework" title="Remove">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {entry.scan && (
        <img className="hw-scan" src={entry.scan} alt="The problem as printed" />
      )}

      <ol className="hw-steps">
        {steps.map((s, i) => (
          <li key={s.line} className={`hw-step${i === steps.length - 1 && entry.arrived ? " final" : ""}`}>
            <span className="hw-step-math">{s.latex ? <MathText latex={s.latex} /> : <em>unreadable</em>}</span>
            {s.check === "verified" && <span className="hw-check" title="Verified algebraically">✓</span>}
          </li>
        ))}
      </ol>

      {!entry.arrived && <p className="hw-unfinished no-print">Not finished yet. Solve it on the board and it updates here.</p>}

      {showInk && entry.ink && <img className="hw-ink" src={entry.ink} alt="My handwriting" />}

      <textarea
        className="hw-note"
        value={entry.note}
        onChange={(e) => onNote(e.target.value)}
        placeholder="Add a note: units, a sentence answer, how you checked it…"
        rows={entry.note ? Math.min(6, entry.note.split("\n").length + 1) : 1}
        aria-label="Note"
      />
    </li>
  );
}
