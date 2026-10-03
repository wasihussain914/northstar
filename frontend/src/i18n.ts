/** Languages the tutor can guide in. Server guidance (hints, nudges, answers)
 * is written by Claude in the chosen language; these are the GPS voice's few
 * built-in phrases plus the speech-synthesis locale. */

export const LANGUAGES = [
  { code: "en", label: "English", speech: "en-US" },
  { code: "es", label: "Español", speech: "es-ES" },
  { code: "fr", label: "Français", speech: "fr-FR" },
  { code: "zh", label: "中文", speech: "zh-CN" },
  { code: "hi", label: "हिन्दी", speech: "hi-IN" },
  { code: "bn", label: "বাংলা", speech: "bn-BD" },
] as const;

export type Lang = (typeof LANGUAGES)[number]["code"];

export function speechLocale(lang: Lang): string {
  return LANGUAGES.find((l) => l.code === lang)?.speech ?? "en-US";
}

interface Phrases {
  backOnRoute: string;
  arrived: string;
  recalculating: (line: number) => string;
}

export const PHRASES: Record<Lang, Phrases> = {
  en: {
    backOnRoute: "Back on route.",
    arrived: "You have arrived. Nice work.",
    recalculating: (l) => `Recalculating. Take another look at line ${l}.`,
  },
  es: {
    backOnRoute: "De vuelta en la ruta.",
    arrived: "Has llegado. ¡Buen trabajo!",
    recalculating: (l) => `Recalculando. Vuelve a mirar la línea ${l}.`,
  },
  fr: {
    backOnRoute: "De retour sur la route.",
    arrived: "Vous êtes arrivé. Bravo !",
    recalculating: (l) => `Recalcul en cours. Regarde à nouveau la ligne ${l}.`,
  },
  zh: {
    backOnRoute: "回到路线上了。",
    arrived: "你已到达目的地。做得好！",
    recalculating: (l) => `正在重新规划路线。请再看看第 ${l} 行。`,
  },
  hi: {
    backOnRoute: "वापस रास्ते पर।",
    arrived: "आप पहुँच गए। बहुत बढ़िया!",
    recalculating: (l) => `रास्ता फिर से बनाया जा रहा है। लाइन ${l} को फिर से देखें।`,
  },
  bn: {
    backOnRoute: "আবার পথে ফিরে এসেছ।",
    arrived: "তুমি পৌঁছে গেছ। দারুণ কাজ!",
    recalculating: (l) => `পথ আবার হিসাব করা হচ্ছে। লাইন ${l} আবার দেখো।`,
  },
};
