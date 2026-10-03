export type LineStatus = "ok" | "error" | "caution" | "unclear" | "pending" | "skip";

export interface CheckedLine {
  line: number;
  latex: string;
  sympy: string;
  kind: string;
  status: LineStatus;
  /** "verified" = SymPy proved it; "ai" = Claude's judgment only. */
  source: "verified" | "ai";
  detail: string;
}

export interface CheckResult {
  lines: CheckedLine[];
  first_error: number | null;
  hints: string[];
  /** ≤4-word teacher margin notes, one per hint level. */
  hint_ink: string[];
  spoken_nudge: string;
  next_step_hint: string;
  /** ≤4-word teacher margin note matching next_step_hint. */
  next_step_ink: string;
  on_track_message: string;
  eta_steps: number;
  route_note: string;
  arrived: boolean;
  verified: boolean;
  timing_ms: { read: number; total: number };
}

/** Hostname of the FastAPI process. Unset/empty → this machine (teammate default). */
// const API_HOST = String(import.meta.env.VITE_BACKEND_IP ?? "").trim() || "localhost";
// const API_BASE = `http://${API_HOST}:5173`;
const API_BASE = ""
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Server error (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return res.json();
}

/** `transcript`: lines the student typed (line -> exact text). */
export function checkBoard(problem: string, image: string, lines: number[], transcript?: Record<number, string>) {
  return post<CheckResult>("/api/check", { problem, image, lines, transcript });
}

export function askTutor(req: {
  problem: string;
  question: string;
  image?: string;
  context: string;
  transcript?: Record<number, string>;
}) {
  return post<{ answer: string }>("/api/ask", req);
}

export async function health(): Promise<{ ok: boolean; has_key: boolean; fake?: boolean } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}
