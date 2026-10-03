import { useState } from "react";
import { practiceProblem } from "./api";
import type { Lang } from "./i18n";
import { MathText } from "./MathText";

export interface Twin {
  problem: string;
  latex: string;
  skill: string;
}

interface Props {
  problem: string;
  /** The wrong turn this trip: the line as written, and the safe note about it. */
  mistake: { line: number; latex: string; note: string };
  lang: Lang;
  onDrive: (twin: Twin) => void;
}

/**
 * The detour: after arriving on a trip that had a wrong turn, offer one fresh
 * problem that exercises exactly the skill that went wrong.
 */
export function PracticeCard({ problem, mistake, lang, onDrive }: Props) {
  const [twin, setTwin] = useState<Twin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chart = async () => {
    setBusy(true);
    setError(null);
    try {
      setTwin(await practiceProblem({ problem, wrong_line: mistake.latex, note: mistake.note, lang }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card practice">
      <span className="eyebrow">Detour practice</span>
      {twin ? (
        <>
          <span className="skill-chip">{twin.skill}</span>
          <p className="practice-problem">
            <MathText latex={twin.latex || twin.problem} />
          </p>
          <button className="btn primary wide" onClick={() => onDrive(twin)}>
            Drive it
          </button>
        </>
      ) : (
        <>
          <p className="practice-lead">
            That wrong turn at line {mistake.line} — want one more problem that works the same muscle?
          </p>
          <button className="btn wide" onClick={chart} disabled={busy}>
            {busy ? "Charting a detour…" : "Give me a detour"}
          </button>
          {error && <p className="practice-error">{error}</p>}
        </>
      )}
    </section>
  );
}
