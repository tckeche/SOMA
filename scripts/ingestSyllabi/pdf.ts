/**
 * Syllabus PDF → plain text. Uses poppler's `pdftotext -layout` (the same
 * tool that the manual Phase 1 sampling relied on) because its column-aware
 * layout preservation is essential for parsing the two-column "Candidates
 * should be able to | Notes and examples" tables that Cambridge subject
 * content pages use.
 *
 * We intentionally do NOT use server/services/aiPipeline's
 * parsePdfTextFromBuffer here — that parser was written for user-uploaded
 * documents and only reads Tj/TJ operators, which loses the column layout
 * that the pattern parsers depend on.
 */

import { spawnSync } from "child_process";
import fs from "fs";

export interface PdfToTextResult {
  text: string;
  pageCount: number;
}

function requirePdftotext(): string {
  const which = spawnSync("which", ["pdftotext"], { encoding: "utf8" });
  if (which.status !== 0 || !which.stdout.trim()) {
    throw new Error(
      "pdftotext is not installed. Install poppler-utils (apt install poppler-utils / brew install poppler) before running the syllabus ingestion.",
    );
  }
  return which.stdout.trim();
}

let pdftotextPathCache: string | null = null;
function pdftotextPath(): string {
  if (!pdftotextPathCache) pdftotextPathCache = requirePdftotext();
  return pdftotextPathCache;
}

/**
 * Extract layout-preserving text from a PDF file.
 * Throws on any pdftotext failure rather than returning a partial result —
 * partial syllabus ingestion would hide silent data loss.
 */
export function extractPdfText(absolutePath: string): PdfToTextResult {
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`PDF not found: ${absolutePath}`);
  }
  const pdftotext = pdftotextPath();
  const proc = spawnSync(pdftotext, ["-layout", "-enc", "UTF-8", absolutePath, "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    throw new Error(`pdftotext failed for ${absolutePath}: ${proc.stderr?.trim() || "unknown error"}`);
  }
  const text = proc.stdout ?? "";

  // pdfinfo is optional — only used for logging, so fail soft.
  let pageCount = 0;
  const info = spawnSync("pdfinfo", [absolutePath], { encoding: "utf8" });
  if (info.status === 0) {
    const m = info.stdout.match(/^Pages:\s+(\d+)/m);
    if (m) pageCount = parseInt(m[1], 10);
  }

  return { text, pageCount };
}
