import { useEffect, useRef, useState } from "react";
import { MathText } from "./MathText";

interface Props {
  problem: string;
  /** LaTeX for pretty display, when the problem came from a scan. */
  latex: string;
  /** Cropped homework image the problem was read from, if any. */
  image: string | null;
  /** A trip with several stops: which one we're on, and how to jump. */
  stopIndex?: number;
  stopCount?: number;
  onJumpStop?: (i: number) => void;
  onEdit: (problem: string) => void;
  onScan: () => void;
  /** How the work is going, shown on the card so it never covers the page. */
  status?: React.ReactNode;
}

/**
 * Where we're headed: the problem, front and center above the paper — as the
 * scanned crop of real homework when there is one, editable text when not.
 */
export function DestinationCard({ problem, latex, image, stopIndex = 0, stopCount = 0, onJumpStop, onEdit, onScan, status }: Props) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const pretty = !editing && problem && latex;

  return (
    <section className="destination-card">
      <div className="destination-main">
        <span className="eyebrow">Destination</span>
        {stopCount > 1 && (
          <span className="trip-strip" aria-label={`Stop ${stopIndex + 1} of ${stopCount}`}>
            <span className="stop-chip">Stop {stopIndex + 1} of {stopCount}</span>
            {Array.from({ length: stopCount }, (_, i) => (
              <button
                key={i}
                className={`stop-dot${i === stopIndex ? " here" : ""}${i < stopIndex ? " done" : ""}`}
                onClick={() => onJumpStop?.(i)}
                aria-label={`Go to stop ${i + 1}`}
                title={`Stop ${i + 1}`}
              />
            ))}
          </span>
        )}
        {image && (
          <button className="destination-snap" onClick={onScan} title="Scan a different problem">
            <img src={image} alt="The problem, from your homework" />
          </button>
        )}
        {pretty ? (
          <button className="destination-math" onClick={() => setEditing(true)} title="Edit the problem">
            <span className="destination-verb">{problem.replace(/[^a-zA-Z].*$/s, "")}</span>
            <MathText latex={latex} />
          </button>
        ) : (
          <input
            ref={inputRef}
            className="destination-input"
            value={problem}
            onChange={(e) => onEdit(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => e.key === "Enter" && setEditing(false)}
            placeholder="Type a problem, e.g. Solve 3(x − 2) + 5 = 2x + 9"
            spellCheck={false}
          />
        )}
      </div>
      {status}
      <button className="btn scan-btn" onClick={onScan}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <circle cx="12" cy="13.5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        <span>Scan homework</span>
      </button>
    </section>
  );
}
