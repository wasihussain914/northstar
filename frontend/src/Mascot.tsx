import { useEffect, useRef, useState } from "react";
import { GRIN, charWeight, mouthGeometry, visemeAt, wordStarts } from "./lipsync";
import { audioLevel, caption, onSpeech, onSpeechSync, speak } from "./voice";

/**
 * Pip: North Star's co-pilot, dressed for Cornell (carnelian and white, a
 * bear-eared beanie for the Big Red). A paper-cutout navigator who lip-syncs the GPS
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
  "Go Big Red!",
  "Ithaca is gorges. So is this math.",
  "Easier than walking up Libe Slope.",
  "Bundle up. It's cold in Ithaca.",
];

const HIDE_KEY = "ns-pip-hidden";

/** The SVG parts the talking animation moves directly, frame by frame. */
interface Rig {
  nod: SVGGElement | null;
  arm: SVGGElement | null;
  mouth: SVGPathElement | null;
  teeth: SVGPathElement | null;
  tongue: SVGEllipseElement | null;
}

/** Where we are in the sentence being spoken. */
interface Utterance {
  text: string;
  cps: number;
  starts: number[];
  startedAt: number;
  /** The engine has said it started (or we gave up waiting for it to). */
  started: boolean;
  /** Character position, fractional. */
  pos: number;
}

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

export function Mascot({ mood, voiceOn, besideDrawer = false }: {
  mood: PipMood;
  voiceOn: boolean;
  /** The route drawer is sliding over the board: step out of its way. */
  besideDrawer?: boolean;
}) {
  const [talking, setTalking] = useState(false);
  const [bubble, setBubble] = useState("");
  // Index of the last word spoken, for the karaoke caption (-1: none yet).
  const [saidWord, setSaidWord] = useState(-1);
  const [hop, setHop] = useState(0);
  const [hidden, setHidden] = useState(readHidden);
  const hideTimer = useRef<number | undefined>(undefined);
  const lastQuip = useRef(-1);
  const rig = useRef<Rig>({ nod: null, arm: null, mouth: null, teeth: null, tongue: null });
  const utterance = useRef<Utterance>({ text: "", cps: 14.5, starts: [], startedAt: 0, started: false, pos: 0 });

  // Caption whatever the GPS voice says, and follow along as it's spoken.
  useEffect(() => {
    const offSpeech = onSpeech((s) => {
      window.clearTimeout(hideTimer.current);
      setTalking(s.speaking && !s.silent);
      if (s.speaking) {
        const u = utterance.current;
        if (s.text !== u.text || !u.text) {
          utterance.current = {
            text: s.text, cps: s.cps, starts: wordStarts(s.text), startedAt: performance.now(), started: false, pos: 0,
          };
          setSaidWord(-1);
        } else {
          u.cps = s.cps; // refined once the neural voice's length is known
        }
        setBubble(s.text);
      } else {
        hideTimer.current = window.setTimeout(() => setBubble(""), 1600);
      }
    });
    const offSync = onSpeechSync((charIndex) => {
      const u = utterance.current;
      u.started = true;
      if (charIndex === 0) u.startedAt = performance.now();
      u.pos = charIndex;
    });
    return () => {
      offSpeech();
      offSync();
      window.clearTimeout(hideTimer.current);
    };
  }, []);

  // While talking: shape the mouth to the letter being said, nod along, gesture.
  useEffect(() => {
    if (!talking) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let frame = 0;
    let last = performance.now();
    let open = 0;
    let width = 1;
    let charIdx = -1;
    let jitter = 1;
    let word = -1;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const u = utterance.current;
      // Engines that never report starting (and silenced tests) still animate.
      if (!u.started && now - u.startedAt > 450) u.started = true;

      let targetOpen = 0;
      let targetWidth = 1;
      if (u.started) {
        u.pos = Math.min(u.text.length, u.pos + (dt * u.cps) / charWeight(u.text[Math.floor(u.pos)]));
        const i = Math.floor(u.pos);
        if (i !== charIdx) {
          charIdx = i;
          jitter = 0.82 + Math.random() * 0.32; // no two syllables quite alike
        }
        const v = visemeAt(u.text, u.pos);
        targetOpen = v.open * jitter;
        targetWidth = v.width;
        const level = audioLevel();
        if (level !== null) targetOpen *= Math.min(1.25, 0.2 + level * 1.6);

        let w = -1;
        while (w + 1 < u.starts.length && u.starts[w + 1] <= u.pos) w++;
        if (w !== word) {
          word = w;
          setSaidWord(w);
        }
      }

      open += (targetOpen - open) * (1 - Math.exp(-dt / 0.05));
      width += (targetWidth - width) * (1 - Math.exp(-dt / 0.07));
      const g = mouthGeometry(open, width);
      const r = rig.current;
      r.mouth?.setAttribute("d", g.d);
      r.teeth?.setAttribute("d", g.teeth);
      r.teeth?.setAttribute("opacity", g.showTeeth ? "1" : "0");
      if (r.tongue) {
        r.tongue.setAttribute("cy", g.tongue.cy.toFixed(2));
        r.tongue.setAttribute("rx", g.tongue.rx.toFixed(2));
        r.tongue.setAttribute("ry", g.tongue.ry.toFixed(2));
        r.tongue.setAttribute("opacity", g.tongue.visible ? "1" : "0");
      }
      if (!still) {
        const t = now / 1000;
        r.nod?.setAttribute("transform", `rotate(${(Math.sin(t * 4.7) * 1.4 + open * 1.6).toFixed(2)} 80 140) translate(0 ${(-open * 1.6).toFixed(2)})`);
        r.arm?.setAttribute("transform", `rotate(${(-12 - 12 * Math.sin(t * 2.6)).toFixed(2)} 115 150)`);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      const r = rig.current;
      r.mouth?.setAttribute("d", GRIN.d);
      r.teeth?.setAttribute("d", GRIN.teeth);
      r.teeth?.setAttribute("opacity", "1");
      r.tongue?.setAttribute("cy", String(GRIN.tongue.cy));
      r.tongue?.setAttribute("rx", String(GRIN.tongue.rx));
      r.tongue?.setAttribute("ry", String(GRIN.tongue.ry));
      r.tongue?.setAttribute("opacity", "1");
      r.nod?.removeAttribute("transform");
      r.arm?.removeAttribute("transform");
    };
  }, [talking]);

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
    <div className={`pip mood-${mood}${talking ? " talking" : ""}${besideDrawer ? " beside-drawer" : ""}`}>
      <div className={`pip-bubble${bubble ? " show" : ""}`} aria-live="polite">
        {talking ? <Karaoke text={bubble} saidWord={saidWord} /> : bubble}
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
        <PipSvg rig={rig.current} />
      </button>
    </div>
  );
}

/** The caption, lighting up each word as it's spoken. */
function Karaoke({ text, saidWord }: { text: string; saidWord: number }) {
  let word = -1;
  return (
    <>
      {text.split(/(\s+)/).map((part, i) => {
        if (!part.trim()) return part;
        word++;
        return (
          <span key={i} className={word <= saidWord ? "said" : "ahead"}>
            {part}
          </span>
        );
      })}
    </>
  );
}

const SKIN = "#f7d9b5";
const SKIN_EDGE = "#e2b78c";
const RED = "#b31b1b"; // Cornell carnelian
const RED_DARK = "#8c1515";
const GOLD = "#f5c451";
const INK = "#2a211c";

function PipSvg({ rig }: { rig: Rig }) {
  return (
    <svg viewBox="0 0 160 200" aria-hidden="true">
      <ellipse className="pip-shadow" cx="80" cy="194" rx="36" ry="5" fill="rgba(0,0,0,0.22)" />
      <g className="pip-body">
        <defs>
          {/* red-and-white knit stripes for the scarf */}
          <pattern id="pip-stripes" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(40)">
            <rect width="7" height="7" fill="#fff" />
            <rect width="3.5" height="7" fill={RED} />
          </pattern>
        </defs>

        {/* jeans and white sneakers with red soles */}
        <rect x="63" y="168" width="12" height="18" rx="3" fill="#2d3a57" />
        <rect x="85" y="168" width="12" height="18" rx="3" fill="#2d3a57" />
        <ellipse cx="67" cy="187" rx="12.5" ry="6.5" fill="#f6f6f4" stroke="#cfd2d8" strokeWidth="1.5" />
        <ellipse cx="93" cy="187" rx="12.5" ry="6.5" fill="#f6f6f4" stroke="#cfd2d8" strokeWidth="1.5" />
        <path d="M55.5 189.5 Q67 195 78.5 189.5" fill="none" stroke={RED} strokeWidth="2.5" strokeLinecap="round" />
        <path d="M81.5 189.5 Q93 195 104.5 189.5" fill="none" stroke={RED} strokeWidth="2.5" strokeLinecap="round" />

        {/* arms (behind the sweater), white-striped cuffs */}
        <g className="pip-arm pip-arm-l">
          <rect x="38" y="146" width="13" height="27" rx="6.5" fill={RED} />
          <rect x="38" y="163" width="13" height="3" fill="#fff" />
          <circle cx="44.5" cy="174" r="6.5" fill={SKIN} stroke={SKIN_EDGE} strokeWidth="1.5" />
        </g>
        <g ref={(el) => { rig.arm = el; }}>
        <g className="pip-arm pip-arm-r">
          <rect x="109" y="146" width="13" height="27" rx="6.5" fill={RED} />
          <rect x="109" y="163" width="13" height="3" fill="#fff" />
          <circle cx="115.5" cy="174" r="6.5" fill={SKIN} stroke={SKIN_EDGE} strokeWidth="1.5" />
        </g>
        </g>

        {/* Big Red varsity sweater with a white C */}
        <path d="M46 180 Q44 142 80 137 Q116 142 114 180 Z" fill={RED} />
        <rect x="46" y="173" width="68" height="7" fill={RED_DARK} />
        <rect x="46" y="175.5" width="68" height="2" fill="#fff" opacity="0.85" />
        <text x="83" y="171" textAnchor="middle" fontSize="23" fontWeight="800" fontFamily="Georgia, 'Times New Roman', serif" fill="#fff">
          C
        </text>

        {/* striped scarf: around the neck, one end hanging down */}
        <path d="M61 140 Q80 154 99 140 L97 149 Q80 161 63 149 Z" fill="url(#pip-stripes)" stroke={RED_DARK} strokeWidth="1" />
        <path d="M58 145 L66 148.5 L63 168 L54 165 Z" fill="url(#pip-stripes)" stroke={RED_DARK} strokeWidth="1" />
        <path d="M54 165 L53 169 M57 166 L56.4 170 M60 167 L59.5 171 M63 168 L62.6 172" stroke={RED_DARK} strokeWidth="1.4" strokeLinecap="round" />

        <g ref={(el) => { rig.nod = el; }}>
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
          {/* red knit beanie with little bear ears (go Big Red), North Star pin on the cuff */}
          <g className="pip-hat">
            <circle cx="41" cy="23" r="12" fill={RED} />
            <circle cx="41" cy="23" r="6" fill="#f2b3b0" />
            <circle cx="119" cy="23" r="12" fill={RED} />
            <circle cx="119" cy="23" r="6" fill="#f2b3b0" />
            <path d="M30 58 Q30 8 80 6 Q130 8 130 58 Z" fill={RED} />
            <path d="M55 52 Q54 22 62 12 M80 52 V7 M105 52 Q106 22 98 12" fill="none" stroke="rgba(0,0,0,0.12)" strokeWidth="2" strokeLinecap="round" />
            <rect x="27" y="46" width="106" height="15" rx="7.5" fill={RED_DARK} />
            <rect x="30" y="51.5" width="100" height="4" rx="2" fill="#fff" opacity="0.9" />
            <path d="M112 46.5 L114.4 51.6 L119.5 54 L114.4 56.4 L112 61.5 L109.6 56.4 L104.5 54 L109.6 51.6 Z" fill={GOLD} stroke="#c99a2e" strokeWidth="0.8" />
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
          {/* the talking mouth: reshaped every frame while Pip speaks, a grin otherwise */}
          <g className="pip-m pip-m-open">
            <path ref={(el) => { rig.mouth = el; }} d={GRIN.d} fill="#5a1f24" />
            <ellipse
              ref={(el) => { rig.tongue = el; }}
              cx="80"
              cy={GRIN.tongue.cy}
              rx={GRIN.tongue.rx}
              ry={GRIN.tongue.ry}
              fill="#e86a6a"
            />
            <path ref={(el) => { rig.teeth = el; }} d={GRIN.teeth} fill="#fff" />
          </g>
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
