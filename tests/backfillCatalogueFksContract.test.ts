/**
 * Contract test for `scripts/backfillCatalogueFks.ts`.
 *
 * Phase 25 made the subtopic resolver responsible for choosing whether
 * to normalise legacy question tags (raw-first lookup, normalised
 * fallback). For that protection to actually work, the backfill script
 * MUST pass the raw `topic_tag` / `subtopic_tag` values straight into
 * `resolveSubtopicId` instead of pre-cleaning them via
 * `normalizeQuestionTag` — the latter unconditionally splits commas
 * and would mangle clean catalogue titles like
 * "Motion, forces and energy" before the resolver ever sees them.
 *
 * This test guards that contract at the source level so a future
 * refactor can't silently re-introduce the regression.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("backfillCatalogueFks question-tag passthrough contract", () => {
  const source = readFileSync(
    join(process.cwd(), "scripts", "backfillCatalogueFks.ts"),
    "utf8",
  );

  it("passes raw row.topicTag and row.subtopicTag into resolveSubtopicId", () => {
    expect(source).toMatch(/topic:\s*row\.topicTag\b/);
    expect(source).toMatch(/subtopic:\s*row\.subtopicTag\b/);
  });

  it("does NOT pre-normalise question tags before the resolver call", () => {
    // The raw-first protection in `subtopicResolver.ts` is bypassed if
    // the caller wraps the value in `normalizeQuestionTag(...)`. Make
    // sure neither the topic nor subtopic field does that.
    expect(source).not.toMatch(/normalizeQuestionTag\(\s*row\.topicTag\b/);
    expect(source).not.toMatch(/normalizeQuestionTag\(\s*row\.subtopicTag\b/);
  });

  it("does not import normalizeQuestionTag at all (resolver owns normalisation)", () => {
    expect(source).not.toMatch(/from\s+["'].*questionTagNormalizer["']/);
  });
});
