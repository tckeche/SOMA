/**
 * Phase 7 — Semantic topic search.
 *
 * Two-stage retrieval: hard metadata filter first (body / level / subject /
 * tier via the catalogue), then cosine similarity over the embeddings of the
 * surviving topics. This matches the rule "use deterministic lookup first,
 * AI second" — we never search across syllabi the tutor didn't pick.
 *
 * The ranking kernel is a pure function so tests can drive it with fixture
 * vectors and verify top-K ordering without hitting OpenAI or the DB.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  examiningBodies,
  levels,
  subjects,
  syllabi,
  topics,
  type LevelTier,
} from "@shared/schema";
import {
  cosineSimilarity,
  embedQuery,
  loadEmbeddingsForTopics,
  openAIEmbedClient,
  type EmbedClient,
} from "./topicEmbeddings";

export interface RankableTopicEmbedding {
  topicId: number;
  tier: string;
  embedding: number[];
  /** Optional lexical keywords; boost the score when the query overlaps. */
  keywords?: string[];
}

export interface SemanticTopicHit {
  topicId: number;
  tier: string;
  score: number;
  cosineScore: number;
  keywordBoost: number;
}

export interface RankTopicsOptions {
  topK?: number;
  /**
   * Multiplier applied per matching keyword (additive). Defaults to 0.02 per
   * match — enough to break cosine ties on near-synonymous topics, not enough
   * to let keyword spam dominate semantic similarity.
   */
  keywordBoostPerMatch?: number;
  /** Cap the keyword boost so wordy topics don't hog the top of the list. */
  maxKeywordBoost?: number;
  /** Floor score: filter out hits below this. Defaults to 0 (keep all). */
  minScore?: number;
}

function extractQueryTokens(query: string): Set<string> {
  const toks = query.toLowerCase().split(/[^a-z0-9'\-]+/);
  const out = new Set<string>();
  for (const t of toks) {
    const tok = t.replace(/^['-]+|['-]+$/g, "");
    if (tok.length >= 3) out.add(tok);
  }
  return out;
}

/**
 * Pure ranking kernel. Given a query vector, a query string (for keyword
 * boost), and candidate topic embeddings, return top-K hits sorted by score
 * descending. Deterministic — ties broken by (topicId, tier).
 */
export function rankTopicsBySimilarity(
  queryVector: number[],
  queryText: string,
  candidates: RankableTopicEmbedding[],
  opts: RankTopicsOptions = {},
): SemanticTopicHit[] {
  const topK = opts.topK ?? 5;
  const perMatch = opts.keywordBoostPerMatch ?? 0.02;
  const maxBoost = opts.maxKeywordBoost ?? 0.1;
  const minScore = opts.minScore ?? 0;

  const queryTokens = extractQueryTokens(queryText);

  const scored: SemanticTopicHit[] = candidates.map((c) => {
    const cosineScore = cosineSimilarity(queryVector, c.embedding);
    let matches = 0;
    if (c.keywords && queryTokens.size > 0) {
      for (const kw of c.keywords) {
        if (queryTokens.has(kw)) matches++;
      }
    }
    const keywordBoost = Math.min(matches * perMatch, maxBoost);
    return {
      topicId: c.topicId,
      tier: c.tier,
      cosineScore,
      keywordBoost,
      score: cosineScore + keywordBoost,
    };
  });

  return scored
    .filter((s) => s.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.topicId !== b.topicId) return a.topicId - b.topicId;
      return a.tier.localeCompare(b.tier);
    })
    .slice(0, topK);
}

// ---------------------------------------------------------------------------
// DB-backed orchestrator
// ---------------------------------------------------------------------------

export interface SemanticTopicSearchParams {
  bodySlug: string;
  levelCode: string;
  subjectSlug: string;
  queryText: string;
  topK?: number;
  /** Optional override client for tests. */
  embedClient?: EmbedClient;
}

export interface SemanticTopicSearchResult {
  hits: SemanticTopicHit[];
  candidateCount: number;
  tier: LevelTier | null;
}

function requireDb(): NonNullable<typeof db> {
  if (!db) throw new Error("Database not connected — semantic search unavailable");
  return db;
}

/**
 * End-to-end: resolve the metadata filter, pull matching topics + their
 * embeddings, embed the query, rank, return top-K. Safe to call when no
 * embeddings exist for the filter — returns `hits: []`.
 */
export async function semanticTopicSearch(
  params: SemanticTopicSearchParams,
): Promise<SemanticTopicSearchResult> {
  const handle = requireDb();
  const filterRows = await handle
    .select({
      topicId: topics.id,
      levelTiers: topics.levelTiers,
      keywords: topics.keywords,
      levelTopBand: levels.topBand,
    })
    .from(topics)
    .innerJoin(syllabi, eq(topics.syllabusId, syllabi.id))
    .innerJoin(subjects, eq(syllabi.subjectId, subjects.id))
    .innerJoin(examiningBodies, eq(syllabi.examiningBodyId, examiningBodies.id))
    .innerJoin(levels, eq(levels.code, params.levelCode))
    .where(
      and(
        eq(examiningBodies.slug, params.bodySlug),
        eq(subjects.slug, params.subjectSlug),
        eq(syllabi.isActive, true),
        eq(syllabi.topBand, levels.topBand),
      ),
    );

  const tier = (params.levelCode as LevelTier) ?? null;
  const relevantTopicIds = filterRows
    .filter((r) => Array.isArray(r.levelTiers) && r.levelTiers.includes(params.levelCode))
    .map((r) => r.topicId);

  if (relevantTopicIds.length === 0) {
    return { hits: [], candidateCount: 0, tier };
  }

  const stored = await loadEmbeddingsForTopics(relevantTopicIds);
  const candidates: RankableTopicEmbedding[] = stored
    .filter((s) => s.tier === params.levelCode)
    .map((s) => {
      const filter = filterRows.find((f) => f.topicId === s.topicId);
      return {
        topicId: s.topicId,
        tier: s.tier,
        embedding: s.embedding,
        keywords: (filter?.keywords as string[]) ?? [],
      };
    });

  if (candidates.length === 0) {
    return { hits: [], candidateCount: 0, tier };
  }

  const client = params.embedClient ?? openAIEmbedClient;
  const queryVector = await embedQuery(params.queryText, client);
  const hits = rankTopicsBySimilarity(queryVector, params.queryText, candidates, {
    topK: params.topK ?? 5,
  });

  return { hits, candidateCount: candidates.length, tier };
}
