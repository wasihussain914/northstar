import { useEffect, useRef, useState } from "react";
import { caption, onSpeech, speak } from "./voice";

/**
 * Pip: North Star's co-pilot. A paper-cutout navigator who lip-syncs the GPS
 * voice (with a caption bubble, so it also works with the sound off), reacts
 * to the route, and hops when poked.
 */

export type PipMood = "idle" | "thinking" | "happy" | "worried" | "party" | "dizzy";

const QUIPS = [
  "I'd say turn left, but this is algebra.",
  "Every wrong turn is just a scenic route.",
  "No tolls on this road. Just x.",
  "I believe in you. And in x.",
  "Recalculating my snack route…",
  "Math is a road trip with numbers.",
  "Buckle up. One step per line!",
  "Hey! I'm navigating here.",
];

const HIDE_KEY = "ns-pip-hidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean) {
  try {
    localStorage.setItem(HIDE_KEY, hidden ? "1" : "0");
  } catch {
    /* storage unavailable: just don't remember */
  }
}

export function Mascot({ mood, voiceOn }: { mood: PipMood; voiceOn: boolean }) {
  const [talking, setTalking] = useState(false);
  const [bubble, setBubble] = useState("");
  const [hop, setHop] = useState(0);
  const [hidden, setHidden] = useState(readHidden);
  const hideTimer = useRef<number | undefined>(undefined);
  const lastQuip = useRef(-1);

  // Lip-sync and caption whatever the GPS voice says.
  useEffect(() => {
    const off = onSpeech((s) => {
      window.clearTimeout(hideTimer.current);
      setTalking(s.speaking && !s.silent);
      if (s.speaking) setBubble(s.text);
      else hideTimer.current = window.setTimeout(() => setBubble(""), 1600);
    });
    return () => {
      off();
      window.clearTimeout(hideTimer.current);
    };
  }, []);

  const poke = () => {
    setHop((n) => n + 1);
    let i = Math.floor(Math.random() * QUIPS.length);
    if (i === lastQuip.current) i = (i + 1) % QUIPS.length;
    lastQuip.current = i;
    if (voiceOn) speak(QUIPS[i]);
    else caption(QUIPS[i]);
  };

  const toggleHidden = (next: boolean) => {
    setHidden(next);
    writeHidden(next);
  };

  if (hidden) {
    return (
      <button className="pip-tab" onClick={() => toggleHidden(false)} title="Bring Pip back">
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 2l3.2 10.8L30 16l-10.8 3.2L16 30l-3.2-10.8L2 16l10.8-3.2z" fill="currentColor" />
        </svg>
        Pip
      </button>
    );
  }

  return (
    <div className={`pip mood-${mood}${talking ? " talking" : ""}`}>
      <div className={`pip-bubble${bubble ? " show" : ""}`} aria-live="polite">
        {bubble}
      </div>
      <button className="pip-hide" onClick={() => toggleHidden(true)} aria-label="Hide Pip" title="Hide Pip">
        ×
      </button>
      <button
        key={hop}
        className={`pip-figure${hop ? " hop" : ""}`}
        onClick={poke}
        aria-label="Pip, your co-pilot. Tap for encouragement."
      >
        <PipSvg />
      </button>
    </div>
  );
}

const SKIN = "#f7d9b5";
const SKIN_EDGE = "#e2b78c";
const NAVY = "#1f3a6b";
const GOLD = "#f5c451";
const INK = "#2a211c";

function PipSvg() {
  return (
    <svg viewBox="0 0 160 200" aria-hidden="true">
      <ellipse className="pip-shadow" cx="80" cy="194" rx="36" ry="5" fill="rgba(0,0,0,0.22)" />
      <g className="pip-body">
        {/* legs and shoes */}
        <rect x="63" y="168" width="12" height="18" rx="3" fill="#2b2f3a" />
        <rect x="85" y="168" width="12" height="18" rx="3" fill="#2b2f3a" />
        <ellipse cx="67" cy="187" rx="12" ry="6.5" fill="#d94f3d" />
        <ellipse cx="93" cy="187" rx="12" ry="6.5" fill="#d94f3d" />

        {/* arms (behind the jacket) */}
        <g className="pip-arm pip-arm-l">
          <rect x="38" y="146" width="13" height="27" rx="6.5" fill={NAVY} />
          <circle cx="44.5" cy="174" r="6.5" fill={SKIN} stroke={SKIN_EDGE} strokeWidth="1.5" />
        </g>
        <g className="pip-arm pip-arm-r">
          <rect x="109" y="146" width="13" height="27" rx="6.5" fill={NAVY} />
          <circle cx="115.5" cy="174" r="6.5" fill={SKIN} stroke={SKIN_EDGE} strokeWidth="1.5" />
        </g>

        {/* jacket, scarf, compass badge */}
        <path d="M46 180 Q44 142 80 137 Q116 142 114 180 Z" fill={NAVY} />
        <path d="M62 140 Q80 153 98 140 L96 148 Q80 160 64 148 Z" fill={GOLD} />
        <circle cx="80" cy="166" r="9" fill={GOLD} />
        <path d="M80 158.5 L82.2 164 L87.5 166 L82.2 168 L80 173.5 L77.8 168 L72.5 166 L77.8 164 Z" fill={NAVY} />

        <g className="pip-head">
          {/* ears */}
          <circle cx="23" cy="92" r="9.5" fill={SKIN} stroke={SKIN_EDGE} strokeWidth="2" />
          <circle cx="137" cy="92" r="9.5" fill={SKIN} stroke={SKIN_EDGE} strokeWidth="2" />
          {/* head */}
          <ellipse cx="80" cy="88" rx="58" ry="53" fill={SKIN} stroke={SKIN_EDGE} strokeWidth="2" />
          {/* hair peeking out under the hat */}
          <path d="M27 60 Q25 74 31 84 Q33 72 40 64 Q34 66 27 60 Z" fill={INK} />
          <path d="M133 60 Q135 74 129 84 Q127 72 120 64 Q126 66 133 60 Z" fill={INK} />
          {/* captain's hat with the North Star badge */}
          <g className="pip-hat">
            <path d="M36 48 Q38 10 80 8 Q122 10 124 48 Z" fill="#e9eef6" stroke="#9aa6ba" strokeWidth="2.5" />
            <rect x="36" y="38" width="88" height="11" rx="3" fill={NAVY} />
            <path d="M28 50 Q80 64 132 50 Q132 57 122 59 Q80 69 38 59 Q28 57 28 50 Z" fill="#14243f" />
            <path d="M80 18 L83.3 26.7 L92 30 L83.3 33.3 L80 42 L76.7 33.3 L68 30 L76.7 26.7 Z" fill={GOLD} />
          </g>

          {/* cheeks */}
          <ellipse className="pip-cheek" cx="45" cy="106" rx="9.5" ry="5.5" fill="#f4a6a0" />
          <ellipse className="pip-cheek" cx="115" cy="106" rx="9.5" ry="5.5" fill="#f4a6a0" />

          {/* brows: shown when thinking or worried */}
          <path className="pip-brow pip-brow-l" d="M52 70 Q62 65 72 69" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
          <path className="pip-brow pip-brow-r" d="M88 69 Q98 65 108 70" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />

          {/* eyes */}
          <g className="pip-eyes">
            <g className="pip-look">
              <ellipse cx="62" cy="86" rx="6.5" ry="8.5" fill="#1d1d24" />
              <ellipse cx="98" cy="86" rx="6.5" ry="8.5" fill="#1d1d24" />
              <circle cx="64.5" cy="82.5" r="2.2" fill="#fff" />
              <circle cx="100.5" cy="82.5" r="2.2" fill="#fff" />
            </g>
          </g>
          <g className="pip-dizzy" fill="none" stroke="#1d1d24" strokeWidth="2.4" strokeLinecap="round">
            <path d="M62 86 m-1 0 a1 1 0 1 1 2 0 a3 3 0 1 1 -6 0 a5 5 0 1 1 10 0 a7 7 0 1 1 -14 0" />
            <path d="M98 86 m-1 0 a1 1 0 1 1 2 0 a3 3 0 1 1 -6 0 a5 5 0 1 1 10 0 a7 7 0 1 1 -14 0" />
          </g>

          {/* mouths: one shows at a time */}
          <path className="pip-m pip-m-smile" d="M67 110 Q80 122 93 110" fill="none" stroke={INK} strokeWidth="3.5" strokeLinecap="round" />
          <path className="pip-m pip-m-worry" d="M70 118 Q80 110 90 118" fill="none" stroke={INK} strokeWidth="3.5" strokeLinecap="round" />
          <ellipse className="pip-m pip-m-o" cx="80" cy="115" rx="4.5" ry="5" fill="#5a1f24" />
          <g className="pip-m pip-m-open">
            <path d="M66 108 Q80 106 94 108 Q93 126 80 127 Q67 126 66 108 Z" fill="#5a1f24" />
            <ellipse cx="80" cy="121" rx="7.5" ry="4" fill="#e86a6a" />
          </g>
        </g>
      </g>

      {/* thought bubble while checking, question mark on a wrong turn */}
      <g className="pip-think" fill="#fff" stroke="#c9ced8" strokeWidth="1.5">
        <circle cx="130" cy="40" r="4" />
        <circle cx="141" cy="27" r="6" />
        <circle cx="153" cy="11" r="8.5" />
      </g>
      <text className="pip-q" x="134" y="40" fontSize="38" fontWeight="800" fill="#f59e0b" stroke="#fff" strokeWidth="2.5" paintOrder="stroke">
        ?
      </text>
    </svg>
  );
}
