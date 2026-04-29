/**
 * Phase 4.2 — Command-Word Coach.
 *
 * Read + write helpers around the `command_word_performance` table.
 * Lives outside storage.ts per server/storage-pattern.md.
 *
 * The Coach key is the NORMALISED command word: lowercased, trimmed,
 * and reduced to the first verb when the source carries trailing
 * qualifiers ("Explain how" → "explain"). This avoids fragmenting the
 * student's accuracy across superficial spelling variants.
 */
import { db } from "../db";
import { commandWordPerformance, type CommandWordPerformance } from "@shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";

const KNOWN_COMMAND_WORDS = new Set([
  "calculate",
  "compare",
  "contrast",
  "define",
  "describe",
  "determine",
  "discuss",
  "draw",
  "estimate",
  "evaluate",
  "explain",
  "find",
  "give",
  "identify",
  "illustrate",
  "interpret",
  "justify",
  "label",
  "list",
  "name",
  "outline",
  "plot",
  "predict",
  "prove",
  "show",
  "solve",
  "sketch",
  "state",
  "suggest",
  "summarise",
  "verify",
]);

/**
 * Normalise a command word into its canonical form. Returns null when
 * no recognisable command word is present.
 */
export function normaliseCommandWord(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z\s]+/g, " ").trim();
  if (!cleaned) return null;
  // First word that matches a known command word.
  for (const word of cleaned.split(/\s+/)) {
    if (KNOWN_COMMAND_WORDS.has(word)) return word;
  }
  // Fallback: the first word, if it looks plausible.
  const first = cleaned.split(/\s+/)[0];
  return first && first.length >= 3 && first.length <= 16 ? first : null;
}

/**
 * Heuristic extractor — pulls a command word out of a question stem
 * when the column wasn't set at generation time. Used during the
 * mastery rollup so legacy questions still feed the coach.
 */
export function extractCommandWordFromStem(stem: string): string | null {
  if (!stem) return null;
  // Look at the first 3 words; common Cambridge stems start with the
  // command word ("Explain why…", "Calculate the…", "State a reason…").
  const head = stem
    .replace(/[\(\)\[\]\{\}\.\,;:\?!]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
  return normaliseCommandWord(head);
}

export interface CommandWordRow {
  commandWord: string;
  attempts: number;
  correct: number;
  accuracyPct: number;
  marksAttempted: number;
  marksAwarded: number;
  marksAccuracyPct: number;
  lastAttemptedAt: string | null;
}

export interface SubjectCommandWordPerformance {
  subject: string;
  rows: CommandWordRow[];
  totalAttempts: number;
  weakestCommandWord: string | null;
}

export interface CommandWordPayload {
  subjects: SubjectCommandWordPerformance[];
}

interface ApplyInput {
  studentId: string;
  subject: string;
  commandWord: string;
  correct: boolean;
  marks: number;
}

/**
 * Bump per-command-word counters for one answer. Idempotency is the
 * caller's problem — call once per answer at grading time.
 */
export async function applyCommandWordResult(input: ApplyInput): Promise<void> {
  if (!db) return;
  const word = normaliseCommandWord(input.commandWord);
  if (!word) return;
  const subject = input.subject.trim() || "General";
  const correct = input.correct ? 1 : 0;
  const marksAwarded = input.correct ? input.marks : 0;
  await db
    .insert(commandWordPerformance)
    .values({
      studentId: input.studentId,
      subject,
      commandWord: word,
      attempts: 1,
      correct,
      marksAttempted: input.marks,
      marksAwarded,
      lastAttemptedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [commandWordPerformance.studentId, commandWordPerformance.subject, commandWordPerformance.commandWord],
      set: {
        attempts: sql`${commandWordPerformance.attempts} + 1`,
        correct: sql`${commandWordPerformance.correct} + ${correct}`,
        marksAttempted: sql`${commandWordPerformance.marksAttempted} + ${input.marks}`,
        marksAwarded: sql`${commandWordPerformance.marksAwarded} + ${marksAwarded}`,
        lastAttemptedAt: new Date(),
        updatedAt: new Date(),
      },
    });
}

export async function listForStudent(studentId: string): Promise<CommandWordPayload> {
  if (!db) return { subjects: [] };
  const rows = await db
    .select()
    .from(commandWordPerformance)
    .where(eq(commandWordPerformance.studentId, studentId))
    .orderBy(commandWordPerformance.subject, desc(commandWordPerformance.attempts));

  const grouped = new Map<string, CommandWordRow[]>();
  for (const r of rows) {
    if (!grouped.has(r.subject)) grouped.set(r.subject, []);
    const accuracy = r.attempts > 0 ? Math.round((r.correct / r.attempts) * 100) : 0;
    const marksAcc = r.marksAttempted > 0 ? Math.round((r.marksAwarded / r.marksAttempted) * 100) : 0;
    grouped.get(r.subject)!.push({
      commandWord: r.commandWord,
      attempts: r.attempts,
      correct: r.correct,
      accuracyPct: accuracy,
      marksAttempted: r.marksAttempted,
      marksAwarded: r.marksAwarded,
      marksAccuracyPct: marksAcc,
      lastAttemptedAt: r.lastAttemptedAt ? r.lastAttemptedAt.toISOString() : null,
    });
  }

  const subjects: SubjectCommandWordPerformance[] = [];
  for (const [subject, rows] of Array.from(grouped.entries())) {
    rows.sort((a, b) => a.accuracyPct - b.accuracyPct); // weakest first
    const totalAttempts = rows.reduce((acc, r) => acc + r.attempts, 0);
    // Weakest = lowest accuracy among rows with at least 3 attempts (smaller
    // samples are too noisy to call out).
    const weakestCandidate = rows.find((r) => r.attempts >= 3);
    subjects.push({
      subject,
      rows,
      totalAttempts,
      weakestCommandWord: weakestCandidate?.commandWord ?? null,
    });
  }
  return { subjects };
}
