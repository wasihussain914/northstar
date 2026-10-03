import { useEffect, useRef, useState } from "react";
import { askTutor, type CheckResult } from "./api";
import { snapshot, type Stroke } from "./board/geometry";
import { typedTranscript } from "./board/handwriting";
import { speak, stopSpeaking } from "./voice";

// Web Speech recognition isn't in TypeScript's DOM types yet.
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}

const RecognitionCtor: (new () => Recognition) | undefined =
  typeof window !== "undefined"
    ? ((window as unknown as Record<string, unknown>).SpeechRecognition ??
        (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as (new () => Recognition) | undefined
    : undefined;

interface Exchange {
  question: string;
  answer: string | null;
  failed?: boolean;
}

interface Props {
  problem: string;
  strokes: Stroke[];
  result: CheckResult | null;
  voiceOn: boolean;
}

/** Talk to the tutor: hold a conversation about the board, by voice or by typing. */
export function AskCard({ problem, strokes, result, voiceOn }: Props) {
  const [listening, setListening] = useState(false);
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<Exchange[]>([]);
  const recognition = useRef<Recognition | null>(null);
  const heard = useRef("");

  useEffect(() => () => recognition.current?.stop(), []);

  const ask = async (question: string) => {
    question = question.trim();
    if (!question) return;
    setDraft("");
    setLog((l) => [...l.slice(-2), { question, answer: null }]);
    const snap = snapshot(strokes);
    try {
      const { answer } = await askTutor({
        problem,
        question,
        image: snap?.image,
        context: describe(result),
        transcript: typedTranscript(strokes),
      });
      setLog((l) => l.map((x) => (x.question === question && x.answer === null ? { ...x, answer } : x)));
      if (voiceOn) speak(answer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLog((l) => l.map((x) => (x.question === question && x.answer === null ? { ...x, answer: message, failed: true } : x)));
    }
  };

  const toggleMic = () => {
    if (!RecognitionCtor) return;
    if (listening) {
      recognition.current?.stop();
      return;
    }
    stopSpeaking();
    const rec = new RecognitionCtor();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    heard.current = "";
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      heard.current = text;
      setDraft(text);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => {
      setListening(false);
      if (heard.current.trim()) ask(heard.current);
    };
    recognition.current = rec;
    rec.start();
    setListening(true);
  };

  return (
    <section className="card ask">
      <span className="eyebrow">Ask North Star</span>
      {log.length > 0 && (
        <ul className="ask-log">
          {log.map((x, i) => (
            <li key={i}>
              <p className="q">{x.question}</p>
              <p className={`a${x.failed ? " failed" : ""}`}>{x.answer ?? <span className="typing" aria-label="Thinking" />}</p>
            </li>
          ))}
        </ul>
      )}
      <form
        className="ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          ask(draft);
        }}
      >
        {RecognitionCtor && (
          <button
            type="button"
            className={`mic${listening ? " live" : ""}`}
            onClick={toggleMic}
            aria-label={listening ? "Stop listening" : "Ask out loud"}
            title={listening ? "Stop listening" : "Ask out loud"}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="7" y="2.5" width="6" height="10" rx="3" fill="currentColor" />
              <path d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={listening ? "Listening…" : "Why is line 2 wrong? What do I do next?"}
          aria-label="Question for North Star"
        />
      </form>
    </section>
  );
}

/** Plain-text summary of the last check, so answers can refer to specific lines. */
function describe(result: CheckResult | null): string {
  if (!result) return "";
  const lines = result.lines.map((l) => `line ${l.line} (${l.status}${l.source === "verified" ? ", verified" : ""}): ${l.latex}`);
  if (result.first_error != null) lines.push(`First wrong turn: line ${result.first_error}.`);
  if (result.arrived) lines.push("The student has reached the answer.");
  return lines.join("\n");
}
