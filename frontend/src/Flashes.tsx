import { useEffect, useMemo, useState, type CSSProperties } from "react";

/**
 * The flashy moments: a GPS-style "Recalculating…" banner that sweeps in when
 * a wrong turn is first flagged, and a gold starburst when you arrive.
 */

export function RecalcBanner({ errorKey, line }: { errorKey: string; line: number | null }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!errorKey) {
      setShow(false);
      return;
    }
    setShow(true);
    const t = window.setTimeout(() => setShow(false), 3200);
    return () => window.clearTimeout(t);
  }, [errorKey]);
  if (!show || line == null) return null;
  return (
    <div className="recalc-banner" role="status">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 10a8 8 0 0114-3M20 14a8 8 0 01-14 3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div>
        <strong>Recalculating…</strong>
        <span>Wrong turn at line {line}</span>
      </div>
    </div>
  );
}

interface Particle {
  style: CSSProperties;
}

/** Fires once each time `fireKey` becomes a new non-empty value. */
export function Starburst({ fireKey }: { fireKey: string }) {
  const particles: Particle[] = useMemo(() => {
    if (!fireKey) return [];
    return Array.from({ length: 28 }, (_, i) => ({
      style: {
        "--a": `${(i / 28) * 360 + (Math.random() - 0.5) * 10}deg`,
        "--d": `${140 + Math.random() * 260}px`,
        "--t": `${0.9 + Math.random() * 0.8}s`,
        "--s": `${0.6 + Math.random() * 1.1}`,
      } as CSSProperties,
    }));
  }, [fireKey]);
  if (!fireKey) return null;
  return (
    <div className="starburst" key={fireKey} aria-hidden="true">
      <div className="starburst-flash" />
      {particles.map((p, i) => (
        <i key={i} style={p.style} />
      ))}
    </div>
  );
}
