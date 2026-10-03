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
}

function speakWithBrowser(text: string) {
  if (!speechSupported) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = locale;
  if (voice) u.voice = voice;
  u.rate = 1.02;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

export function speak(text: string) {
  if (!text) return;
  stopSpeaking();
  if (!serverTts) {
    speakWithBrowser(text);
    return;
  }
  fetch("/api/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
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
      return a.play();
    })
    .catch(() => speakWithBrowser(text));
}

export function stopSpeaking() {
  if (speechSupported) window.speechSynthesis.cancel();
  if (player && !player.paused) player.pause();
}
