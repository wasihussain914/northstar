import { useState } from "react";

export interface TryVerdict {
  phase: "checking" | "ok" | "error";
  message: string;
}

interface Props {
  /** Line the tried step would sit on (for context), or null when the board is full. */
  line: number | null;
  /** Latest verdict for the tried step, or null before the first try. */
  verdict: TryVerdict | null;
  onTry: (text: string) => void;
}

/**
 * The scratchpad: try a step in text and hear whether it works — nothing is
 * written on the notebook. When it checks out, write it yourself with the pen.
 */
export function TypeBar({ line, verdict, onTry }: Props) {
  const [text, setText] = useState("");
  const full = line == null;
  const busy = verdict?.phase === "checking";
  return (
    <div className="type-bar-wrap">
      <form
        className="type-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() || full || busy) return;
          onTry(text.trim());
        }}
      >
        <span className="type-target" aria-hidden="true">
          {full ? "Full" : `Try line ${line}`}
        </span>
        <input
          id="type-step"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={full ? "The board is full. Clear a line to keep going." : "Try a step — I'll say if it works. Nothing is written down."}
          aria-label={full ? "Board full" : `Try a step for line ${line}`}
          disabled={full}
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn" type="submit" disabled={!text.trim() || full || busy}>
          {busy ? "Checking…" : "Check"}
        </button>
      </form>
      {verdict && verdict.phase !== "checking" && (
        <p className={`try-verdict try-${verdict.phase}`} role="status">
          {verdict.phase === "ok" ? "✓ " : "✗ "}
          {verdict.message}
        </p>
      )}
    </div>
  );
}
