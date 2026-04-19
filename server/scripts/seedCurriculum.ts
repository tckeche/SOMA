/**
 * Seed the syllabus intelligence layer from the canonical dataset.
 *
 * This script is idempotent — running it against a populated database is
 * safe and converges on the current dataset. It is invoked automatically at
 * server boot and can also be run manually:
 *
 *   npx tsx server/scripts/seedCurriculum.ts
 */

import { CAMBRIDGE_SEED } from "@shared/curriculum/cambridgeSyllabi";
import { seedCurriculum } from "../services/curriculumRegistry";

export async function runCurriculumSeed(options: { quiet?: boolean } = {}) {
  const log = options.quiet ? () => {} : (m: string) => console.log(`[curriculum-seed] ${m}`);

  try {
    const summary = await seedCurriculum(CAMBRIDGE_SEED);
    log(
      `seeded ${summary.body}: ${summary.levels} levels, ${summary.subjects} subjects, ${summary.syllabi} syllabi, ${summary.papers} papers, ${summary.topics} topics, ${summary.subtopics} subtopics, ${summary.competencies} competencies (${summary.documentsLinked} PDFs linked)`,
    );
    return summary;
  } catch (err: any) {
    // Seeding must never crash server boot — log loudly and move on.
    log(`WARNING: seed failed: ${err?.message || err}`);
    return null;
  }
}

// CLI entry point
const isMain =
  typeof import.meta !== "undefined" &&
  import.meta.url &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  (async () => {
    await import("dotenv/config");
    const { connectDb } = await import("../db");
    await connectDb();
    const { applyBootstrapMigrations } = await import("../bootstrap");
    await applyBootstrapMigrations();
    const result = await runCurriculumSeed();
    if (result) {
      console.log("[curriculum-seed] done.");
    }
    process.exit(0);
  })().catch((e) => {
    console.error("[curriculum-seed] fatal:", e);
    process.exit(1);
  });
}
