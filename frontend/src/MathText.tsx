import katex from "katex";
import { useMemo } from "react";

export function MathText({ latex }: { latex: string }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, { throwOnError: false, displayMode: false, strict: "ignore" });
    } catch {
      return null;
    }
  }, [latex]);
  if (!html) return <code>{latex}</code>;
  return <span className="math" dangerouslySetInnerHTML={{ __html: html }} />;
}
