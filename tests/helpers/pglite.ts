/**
 * Shared PGlite harness for service-level integration tests.
 *
 * `tests/examinerInsightsReviewQueue.pg.test.ts` was the first place we
 * stood up an in-process Postgres so a service could be tested against
 * real SQL semantics (joins, GROUP BY, type casts) instead of just the
 * SQL strings drizzle emits. Other services — storage layer, copilot
 * context, syllabus-topic mapping, etc. — want the same hermetic-Postgres
 * approach but were copy-pasting ~120 lines of boilerplate.
 *
 * This module centralises that boilerplate:
 *
 *   - `MIGRATIONS` is read from `migrations/meta/_journal.json` so the
 *     list never drifts from what `drizzle-kit` would apply to a real db.
 *   - `applyMigrations(pglite)` runs them in order.
 *   - `createTestDb()` builds a PGlite client + drizzle wrapper + a
 *     `teardown()` and returns them as a small object.
 *   - `mockServerDb(getDb)` returns a factory you hand to `vi.mock` so
 *     the service-under-test transparently sees the test database.
 *   - `seedCatalogue()` seeds the body → level → subject → syllabus →
 *     strand → topic → subtopic chain that almost every service-level
 *     test ends up needing.
 *
 * ## Writing a new service-level integration test (5–10 lines)
 *
 * ```ts
 * import { afterAll, beforeAll, describe, it, vi } from "vitest";
 * import { createTestDb, mockServerDb, seedCatalogue } from "./helpers/pglite";
 *
 * let harness: Awaited<ReturnType<typeof createTestDb>> | null = null;
 * vi.mock("../server/db", () => mockServerDb(() => harness?.db ?? null));
 *
 * beforeAll(async () => {
 *   harness = await createTestDb();
 *   await seedCatalogue(harness.db);
 * }, 60_000);
 * afterAll(async () => { await harness?.teardown(); harness = null; });
 *
 * // ...then `import { yourService } from "../server/services/..."` and test it.
 * ```
 *
 * The `vi.mock` factory uses a *getter* (`get db()`) so the service can
 * read `db` after the async `beforeAll` has built it. That's the trick
 * that makes the whole pattern work; don't replace it with a plain
 * property or the service will see `null`.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@shared/schema";
import {
  examiningBodies,
  levels,
  subjects,
  syllabi,
  syllabusStrands,
  topics,
  subtopics,
} from "@shared/schema";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "..", "migrations");

interface JournalEntry {
  idx: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

/**
 * Migration filenames in the order drizzle would apply them. Sourced
 * from `migrations/meta/_journal.json` so this list cannot drift away
 * from what `drizzle-kit push` does in production.
 */
export const MIGRATIONS: readonly string[] = (() => {
  const journalPath = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => `${e.tag}.sql`);
})();

export type TestDrizzleDb = PgliteDatabase<typeof schema>;

export interface TestDbHarness {
  pglite: PGlite;
  db: TestDrizzleDb;
  teardown: () => Promise<void>;
}

export async function applyMigrations(client: PGlite): Promise<void> {
  for (const file of MIGRATIONS) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    if (!sql.trim()) continue;
    // PGlite accepts the whole file at once; drizzle's
    // `--> statement-breakpoint` markers are SQL line comments and are
    // simply ignored by Postgres.
    await client.exec(sql);
  }
}

/**
 * Boot an in-process Postgres, apply every drizzle migration, and
 * return a drizzle-bound client. Caller is responsible for invoking
 * the returned `teardown()` in `afterAll`.
 */
export async function createTestDb(): Promise<TestDbHarness> {
  const pglite = new PGlite();
  await applyMigrations(pglite);
  const db = drizzlePglite(pglite, { schema });
  return {
    pglite,
    db,
    teardown: async () => {
      await pglite.close();
    },
  };
}

/**
 * Build the module shape that mocks `server/db` for a test file.
 *
 * Pass a getter so the service sees the live PGlite-backed db even
 * though it's built asynchronously in `beforeAll`:
 *
 *   vi.mock("../server/db", () => mockServerDb(() => harness?.db ?? null));
 */
export function mockServerDb(getDb: () => TestDrizzleDb | null) {
  return {
    get db() {
      return getDb();
    },
    pool: null,
    connectDb: async () => {},
  };
}

export interface SeededCatalogue {
  bodyId: number;
  levelId: number;
  subjectId: number;
  syllabusId: number;
  strandId: number;
  topicId: number;
  subtopicId: number;
}

export interface SeedCatalogueOptions {
  body?: { slug?: string; displayName?: string };
  level?: { code?: string; displayName?: string; topBand?: string };
  subject?: { name?: string; slug?: string };
  syllabus?: { syllabusCode?: string; title?: string; topBand?: string };
  strand?: { name?: string };
  topic?: { topicNumber?: string; title?: string };
  subtopic?: { subtopicNumber?: string; title?: string; levelTier?: string };
}

/**
 * Seed the examining-bodies → subtopics chain that almost every
 * service-level integration test needs. Defaults match the IGCSE
 * Mathematics 0580 fixtures used by the examiner-insights tests, but
 * every field can be overridden so other tests can describe their own
 * subject area.
 */
export async function seedCatalogue(
  db: TestDrizzleDb,
  opts: SeedCatalogueOptions = {},
): Promise<SeededCatalogue> {
  const [body] = await db
    .insert(examiningBodies)
    .values({
      slug: opts.body?.slug ?? "cambridge",
      displayName: opts.body?.displayName ?? "Cambridge",
    })
    .returning();
  const [level] = await db
    .insert(levels)
    .values({
      code: opts.level?.code ?? "IGCSE",
      displayName: opts.level?.displayName ?? "IGCSE",
      topBand: opts.level?.topBand ?? "IGCSE",
    })
    .returning();
  const [subj] = await db
    .insert(subjects)
    .values({
      examiningBodyId: body.id,
      name: opts.subject?.name ?? "Mathematics",
      slug: opts.subject?.slug ?? "mathematics",
    })
    .returning();
  const [syl] = await db
    .insert(syllabi)
    .values({
      examiningBodyId: body.id,
      subjectId: subj.id,
      topBand: opts.syllabus?.topBand ?? "IGCSE",
      syllabusCode: opts.syllabus?.syllabusCode ?? "0580",
      title: opts.syllabus?.title ?? "Cambridge IGCSE Mathematics",
    })
    .returning();
  const [strand] = await db
    .insert(syllabusStrands)
    .values({
      syllabusId: syl.id,
      name: opts.strand?.name ?? "Number",
    })
    .returning();
  const [topic] = await db
    .insert(topics)
    .values({
      syllabusId: syl.id,
      strandId: strand.id,
      topicNumber: opts.topic?.topicNumber ?? "1",
      title: opts.topic?.title ?? "Number basics",
    })
    .returning();
  const [sub] = await db
    .insert(subtopics)
    .values({
      topicId: topic.id,
      subtopicNumber: opts.subtopic?.subtopicNumber ?? "1.1",
      title: opts.subtopic?.title ?? "Place value",
      levelTier: opts.subtopic?.levelTier ?? "IGCSE",
    })
    .returning();

  return {
    bodyId: body.id,
    levelId: level.id,
    subjectId: subj.id,
    syllabusId: syl.id,
    strandId: strand.id,
    topicId: topic.id,
    subtopicId: sub.id,
  };
}
