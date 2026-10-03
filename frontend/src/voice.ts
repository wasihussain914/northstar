/** The GPS voice: browser speech synthesis, no network needed. */

const PREFERRED = ["Samantha", "Ava", "Allison", "Karen", "Daniel", "Google US English", "Microsoft Aria"];

let voice: SpeechSynthesisVoice | null = null;
let unlocked = false;

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  for (const name of PREFERRED) {
    const v = voices.find((v) => v.name.startsWith(name));
    if (v) return (voice = v);
  }
  voice = voices.find((v) => v.lang.startsWith("en")) ?? null;
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  pickVoice();
  window.speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
}

export const speechSupported = typeof window !== "undefined" && !!window.speechSynthesis;

/** iOS only allows speech after a user gesture; call this from one. */
export function unlockSpeech() {
  if (unlocked || !speechSupported) return;
  unlocked = true;
  const u = new SpeechSynthesisUtterance("");
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

export function speak(text: string) {
  if (!speechSupported || !text) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 1.0;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (speechSupported) window.speechSynthesis.cancel();
}
