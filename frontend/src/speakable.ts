/**
 * Turn LaTeX (or plain typed math) into words a speech synthesizer reads well:
 * "2x^{2} - \frac{1}{2} \le 5" -> "2 x squared minus 1 over 2 is less than or equal to 5".
 * Covers the algebra Untangled handles; anything unknown is passed through.
 */
export function speakable(math: string): string {
  let s = math
    .replace(/−|–/g, "-")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/≤/g, "\\le ")
    .replace(/≥/g, "\\ge ")
    .replace(/≠/g, "\\ne ")
    .replace(/×|·/g, "\\cdot ")
    .replace(/÷/g, "\\div ")
    .replace(/\\left|\\right|\\[,;!]|\\quad/g, " ");

  // Innermost-first so nested fractions and roots read correctly.
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s
      .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, " $1 over $2 ")
      .replace(/\\sqrt\{([^{}]*)\}/g, " the square root of $1 ")
      .replace(/\^\{?2\}?(?![0-9])/g, " squared ")
      .replace(/\^\{?3\}?(?![0-9])/g, " cubed ")
      .replace(/\^\{([^{}]*)\}/g, " to the power $1 ")
      .replace(/\^(\w)/g, " to the power $1 ");
    if (s === before) break;
  }

  s = s
    .replace(/\\leq?\b/g, " is less than or equal to ")
    .replace(/\\geq?\b/g, " is greater than or equal to ")
    .replace(/\\neq?\b/g, " is not equal to ")
    .replace(/\\pm/g, " plus or minus ")
    .replace(/\\(cdot|times)/g, " times ")
    .replace(/\\div/g, " divided by ")
    .replace(/\\pi/g, " pi ")
    .replace(/<=/g, " is less than or equal to ")
    .replace(/>=/g, " is greater than or equal to ")
    .replace(/</g, " is less than ")
    .replace(/>/g, " is greater than ")
    .replace(/=/g, " equals ")
    .replace(/\*/g, " times ")
    .replace(/\//g, " over ")
    .replace(/\\?\b(sin|cos|tan|log|ln|exp)\s*\(/g, " $1 of the quantity ")
    // "2(x" and ")(" are multiplication.
    .replace(/([\w)])\s*\(/g, "$1 times (")
    .replace(/\(/g, " the quantity ")
    .replace(/\)/g, ", ")
    .replace(/\+/g, " plus ")
    // A minus at the start or after an operator is a negative sign.
    .replace(/(^|equals|than|to|plus|times|over|quantity)\s*-\s*/g, "$1 negative ")
    .replace(/-/g, " minus ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[{}]/g, " ")
    // "2x" -> "2 x" so it isn't read as a word.
    .replace(/(\d)([a-zA-Z])/g, "$1 $2")
    .replace(/\s+,/g, ",")
    .replace(/,(\s*(equals|is|,|$))/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,$/, "");
  return s;
}
