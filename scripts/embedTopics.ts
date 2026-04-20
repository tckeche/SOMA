/**
 * Phase 7 — CLI: regenerate topic embeddings.
 *
 * Iterates every active (body, level, subject, syllabus), builds the
 * deterministic topic chunks, and upserts embeddings for any chunk whose
 * `contentHash` has drifted (or doesn't exist yet).
 *
 * Usage:
 *   npx tsx scripts/embedTopics.ts                    # all bodies
 *   npx tsx scripts/embedTopics.ts --body=cambridge   # one body
 *   npx tsx scripts/embedTopics.ts --only=9709        # one syllabus code
 *   npx tsx scripts/embedTopics.ts --dry-run          # build chunks, no API calls
 *
 * Environment:
 *   DATABASE_URL / SUPABASE_URL  — Postgres connection (required)
 *   OPENAI_API_KEY               — required unless --dry-run
 */
import "dotenv/config";
import {
  listExaminingBodies,
  listLevelsForBody,
  listSubjectsForBodyLevel,
  resolveSyllabus,
  listTopics,
  getTopicContext,
} from "../server/services/syllabusCatalogue";
import {
  buildAllTopicChunks,
  type TopicChunkRefs,
} from "../server/services/topicReferenceText";
import {
  embedAndPersistChunks,
  openAIEmbedClient,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSIONS,
  type EmbedClient,
} from "../server/services/topicEmbeddings";

interface CliOptions {
  body: string | null;
  only: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { body: null, only: null, dryRun: false };
  for (const raw of argv.slice(2)) {
    if (raw === "--dry-run") opts.dryRun = true;
    else if (raw.startsWith("--body=")) opts.body = raw.slice("--body=".length);
    else if (raw.startsWith("--only=")) opts.only = raw.slice("--only=".length);
  }
  return opts;
}

const noopEmbedClient: EmbedClient = {
  async embedTexts(texts) {
    return texts.map(() => new Array(DEFAULT_EMBEDDING_DIMENSIONS).fill(0));
  },
};

async function main() {
  const opts = parseArgs(process.argv);
  if (!process.env.DATABASE_URL && !process.env.SUPABASE_URL) {
    console.error("ERROR: DATABASE_URL or SUPABASE_URL must be set.");
    process.exit(1);
  }
  if (!opts.dryRun && !process.env.OPENAI_API_KEY) {
    console.error("ERROR: OPENAI_API_KEY required (or pass --dry-run).");
    process.exit(1);
  }

  const client: EmbedClient = opts.dryRun ? noopEmbedClient : openAIEmbedClient;

  const bodies = await listExaminingBodies();
  const bodiesToProcess = opts.body
    ? bodies.filter((b) => b.slug === opts.body)
    : bodies;

  let totalEmbedded = 0;
  let totalReused = 0;
  let totalSkipped = 0;

  for (const body of bodiesToProcess) {
    const levels = await listLevelsForBody(body.slug);
    for (const level of levels) {
      const subjects = await listSubjectsForBodyLevel(body.slug, level.code);
      for (const subject of subjects) {
        const syllabus = await resolveSyllabus(body.slug, level.code, subject.slug);
        if (!syllabus) continue;
        if (opts.only && syllabus.syllabusCode !== opts.only) continue;

        const topicList = await listTopics(body.slug, level.code, subject.slug);
        if (topicList.length === 0) {
          totalSkipped++;
          continue;
        }
        const topicIds = topicList.map((t) => t.id);
        const topicContexts = await getTopicContext(topicIds);

        const refs: TopicChunkRefs = {
          examiningBody: { slug: body.slug, displayName: body.displayName },
          level: { code: level.code, displayName: level.displayName },
          subject: { slug: subject.slug, name: subject.name },
          syllabusCode: syllabus.syllabusCode,
          syllabusTitle: syllabus.title,
        };
        const chunks = buildAllTopicChunks(refs, topicContexts);

        if (chunks.length === 0) {
          console.log(`[skip] ${body.slug}/${level.code}/${subject.slug} ${syllabus.syllabusCode}: no chunks`);
          continue;
        }

        const results = await embedAndPersistChunks(
          chunks,
          client,
          DEFAULT_EMBEDDING_MODEL,
          DEFAULT_EMBEDDING_DIMENSIONS,
        );
        const embedded = results.filter((r) => r.embedded).length;
        const reused = results.filter((r) => r.reused).length;
        totalEmbedded += embedded;
        totalReused += reused;

        console.log(
          `[${body.slug}/${level.code}/${subject.slug}] ${syllabus.syllabusCode} — ` +
            `${results.length} chunks (${embedded} embedded, ${reused} reused)` +
            (opts.dryRun ? " [dry-run: zero vectors]" : ""),
        );
      }
    }
  }

  console.log("—");
  console.log(`Done. embedded=${totalEmbedded} reused=${totalReused} skipped=${totalSkipped}`);
  if (opts.dryRun) console.log("(dry-run: no real embeddings written)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
