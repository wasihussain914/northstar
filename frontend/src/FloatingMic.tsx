import { useEffect, useRef, useState } from "react";
import { askTutor, type CheckResult } from "./api";
import { snapshot, type Stroke } from "./board/geometry";
import { typedTranscript } from "./board/handwriting";
import { caption, speak, stopSpeaking } from "./voice";
import { speechLocale, type Lang } from "./i18n";

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

interface Props {
  problem: string;
  strokes: Stroke[];
  result: CheckResult | null;
  voiceOn: boolean;
  lang: Lang;
}

function describe(result: CheckResult | null): string {
  if (!result) return "";
  const lines = result.lines
    .filter((l) => l.status !== "skip")
    .map((l) => `line ${l.line} (${l.status}): ${l.latex}`);
  return lines.join("; ");
}

/**
 * Talk while you work: a mic that lives on the paper. Tap, ask out loud,
 * and the tutor answers with the board in view — no panel, no typing.
 */
export function FloatingMic({ problem, strokes, result, voiceOn, lang }: Props) {
  const [state, setState] = useState<"idle" | "listening" | "thinking">("idle");
  const recognition = useRef<Recognition | null>(null);
  const heard = useRef("");

  useEffect(() => () => recognition.current?.stop(), []);

  const ask = async (question: string) => {
    setState("thinking");
    try {
      const { answer } = await askTutor({
        problem,
        question,
        image: snapshot(strokes)?.image,
        context: describe(result),
        transcript: typedTranscript(strokes),
        lang,
      });
      if (voiceOn) speak(answer);
      else caption(answer);
    } catch {
      if (voiceOn) speak("Sorry, I missed that. Ask me again?");
    } finally {
      setState("idle");
    }
  };

  const toggle = () => {
    if (!RecognitionCtor) return;
    if (state === "listening") {
      recognition.current?.stop();
      return;
    }
    if (state === "thinking") return;
    stopSpeaking();
    const rec = new RecognitionCtor();
    rec.lang = speechLocale(lang);
    rec.interimResults = true;
    rec.continuous = false;
    heard.current = "";
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      heard.current = text;
    };
    rec.onerror = () => setState("idle");
    rec.onend = () => {
      if (heard.current.trim()) void ask(heard.current.trim());
      else setState("idle");
    };
    recognition.current = rec;
    // iPad Safari can hang without firing onend/onerror: stop after 20s so
    // "listening" never sticks, and treat a failed start as mic-unavailable.
    const watchdog = window.setTimeout(() => {
      try { rec.stop(); } catch { /* already stopped */ }
      setState("idle");
    }, 20000);
    const done = rec.onend;
    rec.onend = () => {
      window.clearTimeout(watchdog);
      done?.();
    };
    try {
      rec.start();
      setState("listening");
    } catch {
      window.clearTimeout(watchdog);
      setState("idle");
      caption("The mic isn't available here — write your question on the page instead.");
    }
  };

  if (!RecognitionCtor) return null;
  return (
    <button
      className={`floating-mic glass state-${state}`}
      onClick={toggle}
      aria-label={state === "listening" ? "Stop listening" : "Ask out loud"}
      title={state === "listening" ? "Listening — tap when done" : "Ask me anything, out loud"}
    >
      {state === "thinking" ? (
        <span className="mic-thinking" />
      ) : (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="7" y="2.5" width="6" height="10" rx="3" fill="currentColor" />
          <path d="M4.5 9.5a5.5 5.5 0 0011 0M10 15v2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
