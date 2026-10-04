import { useEffect, useRef, useState } from "react";
import { checkPlan } from "./api";
import { speechLocale, type Lang } from "./i18n";
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

interface Props {
  problem: string;
  lang: Lang;
  voiceOn: boolean;
  onClose: () => void;
}

const VERDICT_LABEL = { good: "Route looks good", partial: "Almost a route", off: "That route won't get there" };

/**
 * Route preview: before the pen touches the paper, Untangled asks how you'd
 * solve the whole problem. Say it or type it; the navigator checks the route.
 */
export function PlanCard({ problem, lang, voiceOn, onClose }: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [result, setResult] = useState<{ verdict: "good" | "partial" | "off"; feedback: string } | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const heard = useRef("");

  useEffect(() => () => recognition.current?.stop(), []);

  const submit = async (text: string) => {
    text = text.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await checkPlan({ problem, plan: text, lang });
      setResult({ verdict: res.verdict, feedback: res.feedback });
      if (voiceOn && res.spoken) speak(res.spoken);
    } catch {
      setResult({ verdict: "partial", feedback: "Couldn't check that plan — but go ahead and drive; I'm watching." });
    } finally {
      setBusy(false);
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
    rec.lang = speechLocale(lang);
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
      if (heard.current.trim()) submit(heard.current);
    };
    recognition.current = rec;
    // iPad Safari can hang without firing onend/onerror: stop after 20s so
    // "Listening…" never sticks, and treat a failed start as mic-unavailable.
    const watchdog = window.setTimeout(() => {
      try { rec.stop(); } catch { /* already stopped */ }
      setListening(false);
    }, 20000);
    const done = rec.onend;
    rec.onend = () => {
      window.clearTimeout(watchdog);
      done?.();
    };
    try {
      rec.start();
      setListening(true);
    } catch {
      window.clearTimeout(watchdog);
      setListening(false);
      setDraft("");
    }
  };

  return (
    <div className="plan-card" role="dialog" aria-label="Plan your route">
      <button className="icon-btn plan-close" onClick={onClose} aria-label="Skip planning">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
      <span className="eyebrow gold">Plan your route</span>
      <p className="plan-ask">Before you drive: how would you solve this, start to finish?</p>
      {result && (
        <p className={`plan-feedback verdict-${result.verdict}`}>
          <strong>{VERDICT_LABEL[result.verdict]}.</strong> {result.feedback}
        </p>
      )}
      <form
        className="ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        {RecognitionCtor && (
          <button
            type="button"
            className={`mic${listening ? " live" : ""}`}
            onClick={toggleMic}
            aria-label={listening ? "Stop listening" : "Say your plan"}
            title={listening ? "Stop listening" : "Say your plan"}
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
          placeholder={listening ? "Listening…" : "e.g. distribute the 2, combine the numbers, then get x alone"}
          aria-label="Your plan"
        />
        <button className="btn primary" type="submit" disabled={!draft.trim() || busy}>
          {busy ? "Checking…" : "Check route"}
        </button>
      </form>
      {result?.verdict === "good" && (
        <button className="btn wide plan-go" onClick={onClose}>
          Start driving
        </button>
      )}
    </div>
  );
}
