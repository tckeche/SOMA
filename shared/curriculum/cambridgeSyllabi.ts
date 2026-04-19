/**
 * Canonical Cambridge syllabus dataset.
 *
 * This file is the single source of truth for the structured syllabus
 * intelligence layer. The seed script (`server/scripts/seedCurriculum.ts`)
 * is the only code that reads it; it writes the data into the
 * `examining_bodies` / `curriculum_levels` / `syllabi` / `papers` / `topics`
 * / `subtopics` / `competencies` / `paper_topics` tables.
 *
 * Each syllabus references its real PDF under `curriculum-docs/` via
 * `sourcePath`. The seed script will link the `syllabi.document_id` foreign
 * key to the already-ingested `syllabus_documents` row so the copilot's
 * existing PDF retrieval still works.
 *
 * The syllabus catalogue is expanded subject-by-subject in Phase 2.
 * Phase 1 ships only the body, level and competency taxonomy; adding
 * syllabi later is a pure-data change.
 */

import type { CurriculumSeed } from "./types";

export const CAMBRIDGE_SEED: CurriculumSeed = {
  body: {
    code: "cambridge",
    name: "Cambridge Assessment International Education",
  },
  levels: [
    { code: "IGCSE", name: "IGCSE", sortOrder: 1 },
    { code: "AS", name: "AS Level", sortOrder: 2 },
    { code: "A2", name: "A2 Level", sortOrder: 3 },
  ],
  competencies: [
    {
      code: "knowledge",
      name: "Knowledge",
      description: "Recall of facts, terminology, definitions and conventions.",
      sortOrder: 1,
    },
    {
      code: "understanding",
      name: "Understanding",
      description: "Comprehension of principles, models and relationships.",
      sortOrder: 2,
    },
    {
      code: "application",
      name: "Application",
      description: "Using knowledge and techniques in familiar and unfamiliar contexts.",
      sortOrder: 3,
    },
    {
      code: "calculation",
      name: "Calculation",
      description: "Performing numerical, algebraic or procedural manipulation accurately.",
      sortOrder: 4,
    },
    {
      code: "interpretation",
      name: "Interpretation",
      description: "Reading and interpreting data, graphs, diagrams and sources.",
      sortOrder: 5,
    },
    {
      code: "analysis",
      name: "Analysis",
      description: "Breaking a problem into parts, identifying structure and relationships.",
      sortOrder: 6,
    },
    {
      code: "evaluation",
      name: "Evaluation",
      description: "Judging validity, significance and limitations; making reasoned decisions.",
      sortOrder: 7,
    },
    {
      code: "problem_solving",
      name: "Problem Solving",
      description: "Strategising an unseen problem through a chain of reasoning and technique.",
      sortOrder: 8,
    },
  ],
  // Populated in Phase 2 — each entry is a SyllabusSeed covering one
  // Cambridge syllabus code with its papers, topics, subtopics and
  // competency mapping. See shared/curriculum/types.ts for the shape.
  syllabi: [],
};
