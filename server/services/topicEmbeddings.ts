/**
 * Phase 7 — Topic embeddings service.
 *
 * Thin wrapper around OpenAI's text-embedding-3-small for the curriculum
 * catalogue. Small (1536-dim) and cheap; more than enough for ~300 topics ×
 * 3 tiers. Vectors are persisted in the `topic_embeddings` table as jsonb
 * number[]; at this scale we don't need pgvector.
 *
 * This module only handles:
 *   - calling the embeddings API (one or many chunks at a time)
 *   - persisting + invalidating via content hash
 *   - the pure cosine-similarity kernel
 *
 * Semantic search / ranking lives in `semanticTopicSearch.ts`.
 */
import OpenAI from "openai";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { topicEmbeddings } from "@shared/schema";
import type { TopicChunk } from "./topicReferenceText";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export interface EmbedChunkResult {
  topicId: number;
  tier: string;
  reused: boolean;
  embedded: boolean;
  contentHash: string;
}

function requireDb(): NonNullable<typeof db> {
  if (!db) throw new Error("Database not connected — topic embeddings unavailable");
  return db;
}

function requireOpenAI(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  return new OpenAI({ apiKey });
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ---------------------------------------------------------------------------
// Embedding API
// ---------------------------------------------------------------------------

export interface EmbedClient {
  embedTexts(texts: string[]): Promise<number[][]>;
}

/**
 * Production client — lazy OpenAI init so tests can skip the import path and
 * pass a stub instead.
 */
export const openAIEmbedClient: EmbedClient = {
  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const client = requireOpenAI();
    const resp = await client.embeddings.create({
      model: DEFAULT_EMBEDDING_MODEL,
      input: texts,
    });
    return resp.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding as number[]);
  },
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Embed any chunks whose hash differs from the stored row (or has no stored
 * row yet) and upsert. Returns per-chunk status.
 *
 * `client` is injected so tests can stub the API without monkey-patching.
 */
export async function embedAndPersistChunks(
  chunks: TopicChunk[],
  client: EmbedClient = openAIEmbedClient,
  model = DEFAULT_EMBEDDING_MODEL,
  dimensions = DEFAULT_EMBEDDING_DIMENSIONS,
): Promise<EmbedChunkResult[]> {
  if (chunks.length === 0) return [];
  const handle = requireDb();
  const topicIds = Array.from(new Set(chunks.map((c) => c.topicId)));
  const existing = await handle
    .select({
      topicId: topicEmbeddings.topicId,
      tier: topicEmbeddings.levelTier,
      contentHash: topicEmbeddings.contentHash,
    })
    .from(topicEmbeddings)
    .where(inArray(topicEmbeddings.topicId, topicIds));

  const existingByKey = new Map<string, string>();
  for (const row of existing) {
    existingByKey.set(`${row.topicId}::${row.tier}`, row.contentHash);
  }

  const toEmbed: TopicChunk[] = [];
  const reused: EmbedChunkResult[] = [];
  for (const chunk of chunks) {
    const key = `${chunk.topicId}::${chunk.tier}`;
    const storedHash = existingByKey.get(key);
    if (storedHash && storedHash === chunk.contentHash) {
      reused.push({
        topicId: chunk.topicId,
        tier: chunk.tier,
        reused: true,
        embedded: false,
        contentHash: chunk.contentHash,
      });
    } else {
      toEmbed.push(chunk);
    }
  }

  if (toEmbed.length === 0) return reused;

  const vectors = await client.embedTexts(toEmbed.map((c) => c.text));
  if (vectors.length !== toEmbed.length) {
    throw new Error(
      `Embedding count mismatch: expected ${toEmbed.length}, got ${vectors.length}`,
    );
  }

  const writes: EmbedChunkResult[] = [];
  for (let i = 0; i < toEmbed.length; i++) {
    const chunk = toEmbed[i];
    const vector = vectors[i];
    // Upsert: delete-then-insert keeps the unique (topicId, tier) index clean
    // without depending on onConflict support for the jsonb column.
    await handle
      .delete(topicEmbeddings)
      .where(
        and(
          eq(topicEmbeddings.topicId, chunk.topicId),
          eq(topicEmbeddings.levelTier, chunk.tier),
        ),
      );
    await handle.insert(topicEmbeddings).values({
      topicId: chunk.topicId,
      levelTier: chunk.tier,
      chunkText: chunk.text,
      contentHash: chunk.contentHash,
      embeddingModel: model,
      dimensions,
      embedding: vector,
    });
    writes.push({
      topicId: chunk.topicId,
      tier: chunk.tier,
      reused: false,
      embedded: true,
      contentHash: chunk.contentHash,
    });
  }

  return [...reused, ...writes];
}

export interface StoredTopicEmbedding {
  topicId: number;
  tier: string;
  embedding: number[];
  contentHash: string;
  chunkText: string;
}

export async function loadEmbeddingsForTopics(
  topicIds: number[],
): Promise<StoredTopicEmbedding[]> {
  if (topicIds.length === 0) return [];
  const handle = requireDb();
  const rows = await handle
    .select({
      topicId: topicEmbeddings.topicId,
      tier: topicEmbeddings.levelTier,
      embedding: topicEmbeddings.embedding,
      contentHash: topicEmbeddings.contentHash,
      chunkText: topicEmbeddings.chunkText,
    })
    .from(topicEmbeddings)
    .where(inArray(topicEmbeddings.topicId, topicIds));
  return rows.map((r) => ({
    topicId: r.topicId,
    tier: r.tier,
    embedding: r.embedding as number[],
    contentHash: r.contentHash,
    chunkText: r.chunkText,
  }));
}

export async function embedQuery(
  text: string,
  client: EmbedClient = openAIEmbedClient,
): Promise<number[]> {
  const [vec] = await client.embedTexts([text]);
  if (!vec) throw new Error("Empty embedding response for query");
  return vec;
}
