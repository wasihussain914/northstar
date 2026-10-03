import { useState } from "react";

interface Props {
  /** Line the next typed step goes on. */
  line: number | null;
  /** True when `line` already has work on it and will be replaced. */
  replacing: boolean;
  onSubmit: (text: string) => void;
}

/** Type a step instead of writing it, for anyone who can't (or would rather not) use a pen. */
export function TypeBar({ line, replacing, onSubmit }: Props) {
  const [text, setText] = useState("");
  const full = line == null;
  return (
    <form
      className="type-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim() || full) return;
        onSubmit(text.trim());
        setText("");
      }}
    >
      <span className="type-target" aria-hidden="true">
        {full ? "Full" : replacing ? `Replace ${line}` : `Line ${line}`}
      </span>
      <input
        id="type-step"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={full ? "The board is full. Clear a line to keep going." : "Type a step, e.g. 2x - 6 + 4 = 10"}
        aria-label={full ? "Board full" : replacing ? `Replace line ${line}` : `Type a step for line ${line}`}
        disabled={full}
        autoComplete="off"
        spellCheck={false}
      />
      <button className="btn" type="submit" disabled={!text.trim() || full}>
        {replacing ? "Replace" : "Add"}
      </button>
    </form>
  );
}
