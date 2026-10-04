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
  /** A question written on the board, answered. Null when there isn't one. */
  board_question: { line: number; question: string; answer: string } | null;
  /** Each line as read, to echo back next time so unchanged lines aren't re-read. */
  known: Record<number, KnownLine>;
  known_problem: KnownProblem;
  timing_ms: { read: number; total: number; model_read?: boolean; lines_read?: number };
}

/** A line the server has already read: send it back and only new lines get read. */
export interface KnownLine {
  latex: string;
  sympy: string;
  kind: string;
  ai_verdict: string;
}

export interface KnownProblem {
  problem_sympy: string;
  target_variable: string;
  task: string;
}

export interface HintPack {
  hints: string[];
  hint_ink: string[];
  spoken_nudge: string;
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
export function checkBoard(problem: string, image: string, lines: number[], transcript?: Record<number, string>,
                           lang = "en", answered: number[] = [], known: Record<number, KnownLine> = {},
                           knownProblem: KnownProblem | null = null) {
  return post<CheckResult>("/api/check", {
    problem, image, lines, transcript, lang, answered, known, known_problem: knownProblem,
  });
}

/** The hint ladder for the first wrong turn (fetched after the check, so the check never waits on it). */
export function fetchHints(req: {
  problem: string;
  lines: KnownLine[];
  line_numbers: number[];
  first_error: number;
  known_problem: KnownProblem | null;
  lang: string;
}) {
  return post<HintPack>("/api/hints", req);
}

export function askTutor(req: {
  problem: string;
  question: string;
  image?: string;
  context: string;
  transcript?: Record<number, string>;
  lang?: string;
}) {
  return post<{ answer: string }>("/api/ask", req);
}

/** Route preview: judge the student's plan for the whole problem. */
export function checkPlan(req: { problem: string; plan: string; lang?: string }) {
  return post<{ verdict: "good" | "partial" | "off"; feedback: string; spoken: string }>("/api/plan", req);
}

/** One fresh problem exercising the skill the student just got wrong. */
export function practiceProblem(req: { problem: string; wrong_line: string; note: string; lang?: string }) {
  return post<{ problem: string; latex: string; skill: string }>("/api/practice", req);
}

/** Read the problem(s) off a cropped photo of homework. */
export function readProblem(image: string) {
  return post<{ problems: { problem: string; latex: string }[] }>("/api/problem", { image });
}

export async function health(): Promise<{ ok: boolean; has_key: boolean; tts?: boolean; fake?: boolean } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}
