import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The homework document: every problem you solve on the board is filed here
 * as a write-up (the problem, your steps as clean math, your handwriting), so
 * the finished set can be exported as a PDF and handed in.
 */

export interface HomeworkStep {
  line: number;
  latex: string;
  /** "verified" = SymPy proved it; "ai" = Claude's judgment; "unchecked" otherwise. */
  check: "verified" | "ai" | "unchecked";
}

export interface HomeworkEntry {
  id: string;
  /** Problem number on the sheet is its position; this is the problem as read. */
  problem: string;
  /** Pretty LaTeX for the problem when it came from a scan or Claude read it. */
  latex: string;
  /** Crop of the printed homework the problem came from, if any. */
  scan: string | null;
  steps: HomeworkStep[];
  /** The board as written, black ink on white (PNG data URL). */
  ink: string | null;
  arrived: boolean;
  wrongTurns: number;
  hintsUsed: number;
  durationMs: number | null;
  /** Something you add yourself: units, a sentence answer, a remark. */
  note: string;
  savedAt: number;
}

export interface HomeworkDoc {
  title: string;
  student: string;
  course: string;
  entries: HomeworkEntry[];
}

const KEY = "ns-homework";

const EMPTY: HomeworkDoc = { title: "Homework", student: "", course: "", entries: [] };

function load(): HomeworkDoc {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const d = JSON.parse(raw) as Partial<HomeworkDoc>;
    return {
      title: typeof d.title === "string" ? d.title : EMPTY.title,
      student: typeof d.student === "string" ? d.student : "",
      course: typeof d.course === "string" ? d.course : "",
      entries: Array.isArray(d.entries) ? (d.entries as HomeworkEntry[]).map((e) => ({ ...e, note: e.note ?? "" })) : [],
    };
  } catch {
    return EMPTY;
  }
}

function save(doc: HomeworkDoc) {
  try {
    localStorage.setItem(KEY, JSON.stringify(doc));
  } catch {
    // Out of room: keep the write-ups, drop the handwriting images (oldest first).
    const slim = { ...doc, entries: doc.entries.map((e, i) => (i < doc.entries.length - 3 ? { ...e, ink: null } : e)) };
    try {
      localStorage.setItem(KEY, JSON.stringify(slim));
    } catch {
      try {
        localStorage.setItem(KEY, JSON.stringify({ ...doc, entries: doc.entries.map((e) => ({ ...e, ink: null, scan: null })) }));
      } catch {
        /* it stays in memory for this session */
      }
    }
  }
}

export function sameProblem(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

export function useHomework() {
  const [doc, setDoc] = useState<HomeworkDoc>(load);
  const first = useRef(true);
  useEffect(() => {
    // Don't rewrite storage with what we just read from it.
    if (first.current) {
      first.current = false;
      return;
    }
    save(doc);
  }, [doc]);

  /** Add a write-up, or replace the one for the same problem (you solved it again). */
  const file = useCallback((entry: Omit<HomeworkEntry, "id" | "savedAt" | "note"> & { note?: string }) => {
    setDoc((d) => {
      const i = d.entries.findIndex((e) => sameProblem(e.problem, entry.problem));
      const prev = i >= 0 ? d.entries[i] : null;
      const next: HomeworkEntry = {
        ...entry,
        id: prev?.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        note: entry.note ?? prev?.note ?? "",
        savedAt: Date.now(),
      };
      const entries = prev ? d.entries.map((e, j) => (j === i ? next : e)) : [...d.entries, next];
      return { ...d, entries };
    });
  }, []);

  const update = useCallback((id: string, patch: Partial<HomeworkEntry>) => {
    setDoc((d) => ({ ...d, entries: d.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) }));
  }, []);

  const remove = useCallback((id: string) => {
    setDoc((d) => ({ ...d, entries: d.entries.filter((e) => e.id !== id) }));
  }, []);

  const move = useCallback((id: string, delta: -1 | 1) => {
    setDoc((d) => {
      const i = d.entries.findIndex((e) => e.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= d.entries.length) return d;
      const entries = [...d.entries];
      [entries[i], entries[j]] = [entries[j], entries[i]];
      return { ...d, entries };
    });
  }, []);

  const setMeta = useCallback((patch: Partial<Pick<HomeworkDoc, "title" | "student" | "course">>) => {
    setDoc((d) => ({ ...d, ...patch }));
  }, []);

  const clear = useCallback(() => setDoc((d) => ({ ...d, entries: [] })), []);

  return { doc, file, update, remove, move, setMeta, clear };
}

export type Homework = ReturnType<typeof useHomework>;
