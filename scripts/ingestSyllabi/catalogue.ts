/**
 * Cambridge syllabus PDF catalogue.
 *
 * Walks curriculum-docs/cambridge/syllabi/{IGCSE,A_Level} and returns
 * one CatalogueEntry per _distinct_ syllabus. The four byte-identical
 * Mathematics_9709 / Mechanics_9709 / Pure_Mathematics_9709 /
 * Statistics_9709 PDFs collapse into a single 9709 entry per the spec
 * in curriculum-docs/SYLLABUS_EXTRACTION_SPEC.md.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { LevelTier } from "@shared/schema";

export interface CatalogueEntry {
  subject: string;
  syllabusCode: string;
  topBand: "IGCSE" | "A_Level";
  yearsValidFrom: number | null;
  yearsValidTo: number | null;
  sourceFile: string;
  absolutePath: string;
  contentHash: string;
  successorSyllabusCode: string | null;
  // Tiers this syllabus exposes to tutors. Used only for level/subject
  // catalogue endpoints; authoritative tiering on subtopics comes in Phase 3b.
  supportedTiers: LevelTier[];
}

const CURRICULUM_ROOT = path.resolve(process.cwd(), "curriculum-docs", "cambridge", "syllabi");

// Canonical subject names (see SYLLABUS_EXTRACTION_SPEC.md §4). Maps the raw
// filename subject slug (underscore-separated) to the catalogue subject name.
const SUBJECT_NAME_BY_FILENAME_SLUG: Record<string, string> = {
  Accounting: "Accounting",
  Additional_Mathematics: "Additional Mathematics",
  Biology: "Biology",
  Business: "Business",
  Business_Studies: "Business",
  Chemistry: "Chemistry",
  Computer_Science: "Computer Science",
  Design_and_Technology: "Design and Technology",
  Economics: "Economics",
  English_First_Language: "English",
  English_Language: "English",
  French: "French",
  French_Foreign_Language: "French",
  Geography: "Geography",
  History: "History",
  Literature_in_English: "Literature in English",
  Mathematics: "Mathematics",
  Mechanics: "Mathematics",
  Physics: "Physics",
  Pure_Mathematics: "Mathematics",
  Statistics: "Mathematics",
};

// Syllabi whose successor code we already know from the Cambridge index note.
const SUCCESSOR_BY_CODE: Record<string, string> = {
  "0450": "0264",
};

// Filename groups that are byte-identical copies of the same underlying
// syllabus. Keyed by syllabus code; value is the filename to treat as the
// canonical source, others are skipped.
const DEDUP_CANONICAL_FILE: Record<string, string> = {
  "9709": "Mathematics_9709_2028-2030.pdf",
};

// Filenames to skip entirely (superseded or intentionally redundant copies).
// The 9716 French A-level code is already replaced by 9898 inside Cambridge's
// own filename convention, so the `_replaces_9716` suffix isn't a separate
// file — just a hint we capture on the 9898 entry.
const SKIP_FILES = new Set<string>([]);

function sha256File(absolutePath: string): string {
  const buf = fs.readFileSync(absolutePath);
  return "sha256:" + crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Filenames follow one of:
 *   Subject_Slug_CODE_YYYY-YYYY.pdf
 *   Subject_Slug_CODE_YYYY.pdf
 *   Subject_Slug_CODE_YYYY-YYYY_replaces_PREDECESSOR.pdf
 * This parser is deliberately strict — an unexpected shape throws so the
 * catalogue never silently ingests a malformed filename.
 */
function parseFilename(filename: string, topBand: "IGCSE" | "A_Level"): Omit<CatalogueEntry, "absolutePath" | "contentHash" | "supportedTiers"> {
  const base = filename.replace(/\.pdf$/i, "");
  // Strip optional "_replaces_NNNN" suffix to capture replacement info.
  const replacesMatch = base.match(/^(.*?)_replaces_(\d{4})$/);
  const stripped = replacesMatch ? replacesMatch[1] : base;
  const replacesCode = replacesMatch ? replacesMatch[2] : null;

  // Pull the 4-digit syllabus code. Cambridge codes are always 4 digits.
  const codeMatch = stripped.match(/_(\d{4})_([0-9-]+)$/);
  if (!codeMatch) throw new Error(`Cannot parse syllabus code from filename: ${filename}`);
  const syllabusCode = codeMatch[1];
  const years = codeMatch[2];
  const subjectSlug = stripped.slice(0, codeMatch.index);

  const subject = SUBJECT_NAME_BY_FILENAME_SLUG[subjectSlug];
  if (!subject) throw new Error(`Unknown subject slug "${subjectSlug}" in filename: ${filename}`);

  let yearsValidFrom: number | null = null;
  let yearsValidTo: number | null = null;
  const rangeMatch = years.match(/^(\d{4})(?:-(\d{4}))?$/);
  if (rangeMatch) {
    yearsValidFrom = parseInt(rangeMatch[1], 10);
    yearsValidTo = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : yearsValidFrom;
  }

  const successor = SUCCESSOR_BY_CODE[syllabusCode] ?? null;
  const sourceFile = path.join(topBand, filename);

  // The `_replaces_` suffix is captured as metadata on the notes field later;
  // it does not affect the current syllabus row itself.
  void replacesCode;

  return {
    subject,
    syllabusCode,
    topBand,
    yearsValidFrom,
    yearsValidTo,
    sourceFile,
    successorSyllabusCode: successor,
  };
}

function listPdfs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort();
}

/**
 * Build the catalogue of distinct syllabi. Deduplicates the 9709 bundle and
 * throws on any unknown filename.
 */
export function buildCatalogue(): CatalogueEntry[] {
  const entries: CatalogueEntry[] = [];
  const seenCodes = new Set<string>();

  for (const topBand of ["IGCSE", "A_Level"] as const) {
    const dir = path.join(CURRICULUM_ROOT, topBand);
    for (const filename of listPdfs(dir)) {
      if (SKIP_FILES.has(filename)) continue;

      const parsed = parseFilename(filename, topBand);
      const canonicalForCode = DEDUP_CANONICAL_FILE[parsed.syllabusCode];
      if (canonicalForCode && canonicalForCode !== filename) {
        // A different file is the canonical copy for this code — skip.
        continue;
      }

      const key = `${topBand}:${parsed.syllabusCode}`;
      if (seenCodes.has(key)) {
        throw new Error(`Duplicate ${topBand} syllabus code ${parsed.syllabusCode}: ${filename}`);
      }
      seenCodes.add(key);

      const absolutePath = path.join(dir, filename);
      const contentHash = sha256File(absolutePath);
      const supportedTiers: LevelTier[] = topBand === "IGCSE" ? ["IGCSE"] : ["AS", "A2"];

      entries.push({
        ...parsed,
        absolutePath,
        contentHash,
        supportedTiers,
      });
    }
  }

  return entries;
}

/** Convenience for logging / tests. */
export function summariseCatalogue(entries: CatalogueEntry[]): string {
  const igcse = entries.filter((e) => e.topBand === "IGCSE").length;
  const aLevel = entries.filter((e) => e.topBand === "A_Level").length;
  return `Catalogue: ${entries.length} distinct syllabi (${igcse} IGCSE, ${aLevel} A Level)`;
}
