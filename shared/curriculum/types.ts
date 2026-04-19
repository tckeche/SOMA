/**
 * Canonical types for the syllabus intelligence layer.
 *
 * This file is the shape contract between the seed dataset
 * (`cambridgeSyllabi.ts`) and the registry that loads it into the DB.
 */

export type LevelCode = "IGCSE" | "AS" | "A2";

/**
 * Canonical competency tags. Competencies describe the *kind* of thinking
 * a question tests — not the topic. Diagnosis later asks questions like
 * "which competency is this student weakest at?" across topics.
 *
 * Keep this list small and stable. Adding one is a migration, not an edit.
 */
export const COMPETENCY_CODES = [
  "knowledge",
  "understanding",
  "application",
  "calculation",
  "interpretation",
  "analysis",
  "evaluation",
  "problem_solving",
] as const;
export type CompetencyCode = (typeof COMPETENCY_CODES)[number];

export interface SubtopicSeed {
  name: string;
  code?: string;
  description?: string;
  /**
   * Syllabus "candidates should be able to…" statements. Stored verbatim so
   * the copilot can ground questions on the real assessment objectives.
   */
  learningRequirements: string[];
  /** Competency codes this subtopic primarily tests. */
  competencies?: CompetencyCode[];
}

export interface TopicSeed {
  name: string;
  code?: string;
  description?: string;
  /** Competency → weight map (1..5). Weights feed future diagnosis. */
  competencyWeights?: Partial<Record<CompetencyCode, number>>;
  subtopics: SubtopicSeed[];
}

export interface PaperSeed {
  paperNumber: string;
  title: string;
  level: LevelCode;
  /** Duration in minutes. */
  durationMinutes?: number;
  marks?: number;
  description?: string;
  /**
   * Which topic NAMES (must match TopicSeed.name exactly) this paper examines.
   * This is the mapping that lets us show AS vs A2 distinct topics even when
   * they share a syllabus code.
   *
   * Pass `"*"` to mean "every topic in this syllabus".
   */
  topicNames: string[] | "*";
}

export interface SyllabusSeed {
  /** Cambridge syllabus code, e.g. "9709" or "0580". */
  code: string;
  title: string;
  subjectSlug: string;           // "mathematics", "physics", "additional-mathematics"
  subjectName: string;           // display name, e.g. "Mathematics"
  /**
   * For AS/A2-sharing codes (9709, 9702, …) leave `level` undefined — the AS/A2
   * split is done per-paper. For IGCSE or single-level syllabi, set it.
   */
  level?: LevelCode;
  /** Year range printed on the syllabus PDF, e.g. "2028-2030". */
  yearsValid?: string;
  /** Relative path to the canonical PDF in curriculum-docs/. */
  sourcePath?: string;
  notes?: string;
  papers: PaperSeed[];
  topics: TopicSeed[];
}

export interface CurriculumSeed {
  body: { code: string; name: string };
  levels: Array<{ code: LevelCode; name: string; sortOrder: number }>;
  competencies: Array<{ code: CompetencyCode; name: string; description: string; sortOrder: number }>;
  syllabi: SyllabusSeed[];
}
