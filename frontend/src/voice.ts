/** The GPS voice.
 *
 * Best: the server's neural voice (/api/speak, ElevenLabs behind a key),
 * announced by /api/health as `tts`. Fallback: the browser's speech
 * synthesis, picking the most natural installed voice it can find.
 */

const PREFERRED = ["Samantha", "Ava", "Allison", "Karen", "Daniel", "Google US English", "Microsoft Aria"];
/** Voices whose names carry these markers sound far better than the defaults. */
const QUALITY = ["(Enhanced)", "(Premium)", "Natural", "Neural", "Siri"];

let voice: SpeechSynthesisVoice | null = null;
let unlocked = false;
let locale = "en-US";
let serverTts = false;
let player: HTMLAudioElement | null = null;
let playUrl: string | null = null;

/** What the voice is saying right now, for anything that wants to lip-sync or caption it. */
export interface SpeechState {
  speaking: boolean;
  text: string;
  /** True when the words are shown but not heard (voice off). */
  silent: boolean;
  /** Estimated speaking speed in characters per second (refined once audio length is known). */
  cps: number;
}

/** Browser voices at our rate run about this fast. */
const BROWSER_CPS = 14.5;

type SpeechListener = (s: SpeechState) => void;
const listeners = new Set<SpeechListener>();
let speech: SpeechState = { speaking: false, text: "", silent: false, cps: BROWSER_CPS };
let endTimer: number | undefined;
// Each utterance gets an id; a cancelled one's late "ended" event must not
// stop the one that replaced it.
let talkId = 0;

function emit(next: SpeechState) {
  speech = next;
  for (const l of listeners) l(speech);
}

/** Subscribe to speech start/stop. Returns an unsubscribe function. */
export function onSpeech(listener: SpeechListener): () => void {
  listeners.add(listener);
  listener(speech);
  return () => listeners.delete(listener);
}

type SyncListener = (charIndex: number) => void;
const syncListeners = new Set<SyncListener>();

/**
 * Timing marks while speaking: 0 when the sound actually starts, then the
 * character index of each word as the engine reaches it (where supported).
 */
export function onSpeechSync(listener: SyncListener): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

function sync(id: number, charIndex: number) {
  if (id !== talkId) return;
  for (const l of syncListeners) l(charIndex);
}

function startTalking(text: string, silent = false): number {
  window.clearTimeout(endTimer);
  const id = ++talkId;
  emit({ speaking: true, text, silent, cps: BROWSER_CPS });
  // Not every engine reports the end of an utterance (and tests stub speech
  // out), so stop on a timer sized to the text as a fallback.
  endTimer = window.setTimeout(() => endTalk(id), Math.max(1800, text.length * (silent ? 70 : 85) + 1500));
  return id;
}

function endTalk(id: number) {
  if (id === talkId) stopTalking();
}

function stopTalking() {
  window.clearTimeout(endTimer);
  if (speech.speaking) emit({ ...speech, speaking: false });
}

/** Show words without speaking them, for when the voice is off. */
export function caption(text: string) {
  if (text) startTalking(text, true);
}

/** Tell the voice the server can speak (from /api/health). */
export function setServerTts(on: boolean) {
  serverTts = on;
}

function score(v: SpeechSynthesisVoice): number {
  let s = 0;
  const lang = v.lang.replace("_", "-");
  if (lang.startsWith(locale)) s += 8;
  else if (lang.startsWith(locale.slice(0, 2))) s += 6;
  else return 0;
  if (QUALITY.some((q) => v.name.includes(q))) s += 4;
  const i = PREFERRED.findIndex((name) => v.name.startsWith(name));
  if (i >= 0) s += 3 - i * 0.1;
  if (v.localService) s += 0.5;
  return s;
}

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  voice = voices.reduce<{ v: SpeechSynthesisVoice | null; s: number }>(
    (best, v) => {
      const s = score(v);
      return s > best.s ? { v, s } : best;
    },
    { v: null, s: 0 },
  ).v;
}

/** Switch the GPS voice's language (a BCP-47 locale like "es-ES"). */
export function setSpeechLang(next: string) {
  locale = next;
  if (speechSupported) pickVoice();
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  pickVoice();
  window.speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}

export const speechSupported = typeof window !== "undefined" && !!window.speechSynthesis;

// A sliver of silent WAV, to unlock the audio element inside a user gesture.
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

function getPlayer(): HTMLAudioElement {
  if (!player) player = new Audio();
  return player;
}

// Loudness of the neural voice, for lip-sync. Audio routed through Web Audio
// is silent while its context is suspended, so the graph is only built once
// the context is running (it's resumed inside a user gesture).
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let levelBuf: Float32Array<ArrayBuffer> | null = null;

function ensureAnalyser(a: HTMLAudioElement) {
  if (analyser || !audioCtx || audioCtx.state !== "running") return;
  try {
    const src = audioCtx.createMediaElementSource(a);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    levelBuf = new Float32Array(analyser.fftSize);
  } catch {
    analyser = null;
  }
}

/** How loud the neural voice is right now (0..1), or null when it isn't the one speaking. */
export function audioLevel(): number | null {
  if (!analyser || !levelBuf || !player || player.paused) return null;
  analyser.getFloatTimeDomainData(levelBuf);
  let sum = 0;
  for (const v of levelBuf) sum += v * v;
  return Math.min(1, Math.sqrt(sum / levelBuf.length) * 5);
}

/** iOS only allows sound after a user gesture; call this from one. */
export function unlockSpeech() {
  if (unlocked || typeof window === "undefined") return;
  unlocked = true;
  if (speechSupported) {
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  }
  const a = getPlayer();
  a.src = SILENCE;
  a.play().catch(() => {});
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctx) {
    try {
      audioCtx = new Ctx();
      audioCtx.resume().catch(() => {});
    } catch {
      audioCtx = null;
    }
  }
}

function speakWithBrowser(text: string, id: number) {
  if (!speechSupported) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = locale;
  if (voice) u.voice = voice;
  u.rate = 1.02;
  u.pitch = 1.0;
  u.onstart = () => sync(id, 0);
  u.onboundary = (e) => {
    if (e.name === "word" || !e.name) sync(id, e.charIndex);
  };
  u.onend = () => endTalk(id);
  u.onerror = () => endTalk(id);
  window.speechSynthesis.speak(u);
}

export function speak(text: string) {
  if (!text) return;
  stopSpeaking();
  const id = startTalking(text);
  if (!serverTts) {
    speakWithBrowser(text, id);
    return;
  }
  fetch("/api/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, lang: locale.slice(0, 2) }),
  })
    .then(async (res) => {
      if (!res.ok) {
        if (res.status === 503) serverTts = false; // no key on the server: stop asking
        throw new Error(String(res.status));
      }
      const a = getPlayer();
      if (playUrl) URL.revokeObjectURL(playUrl);
      playUrl = URL.createObjectURL(await res.blob());
      a.src = playUrl;
      a.onplaying = () => {
        window.clearTimeout(endTimer); // the audio's own end event takes over
        if (id !== talkId) return;
        if (Number.isFinite(a.duration) && a.duration > 0) emit({ ...speech, cps: text.length / a.duration });
        sync(id, 0);
      };
      a.onended = () => endTalk(id);
      ensureAnalyser(a);
      return a.play();
    })
    .catch(() => speakWithBrowser(text, id));
}

export function stopSpeaking() {
  if (speechSupported) window.speechSynthesis.cancel();
  if (player && !player.paused) player.pause();
  stopTalking();
}
