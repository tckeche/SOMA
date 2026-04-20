import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
} from "../server/services/topicEmbeddings";
import {
  rankTopicsBySimilarity,
  type RankableTopicEmbedding,
} from "../server/services/semanticTopicSearch";

// Synthetic 3-d vectors so the ranking is easy to reason about.
const VEC_QUADRATICS = [1, 0, 0];
const VEC_CALCULUS = [0, 1, 0];
const VEC_VECTORS = [0, 0, 1];
const VEC_QUAD_ISH = [0.9, 0.1, 0];

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
  });

  it("returns 0 for zero-magnitude inputs", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });

  it("returns 0 when lengths mismatch", () => {
    expect(cosineSimilarity([1, 1], [1, 1, 1])).toBe(0);
  });

  it("correctly ranks close matches higher than distant ones", () => {
    const closeScore = cosineSimilarity([1, 0, 0], [0.9, 0.1, 0]);
    const farScore = cosineSimilarity([1, 0, 0], [0, 1, 0]);
    expect(closeScore).toBeGreaterThan(farScore);
  });
});

describe("rankTopicsBySimilarity", () => {
  const candidates: RankableTopicEmbedding[] = [
    { topicId: 1, tier: "AS", embedding: VEC_QUADRATICS, keywords: ["quadratic", "equations"] },
    { topicId: 2, tier: "AS", embedding: VEC_CALCULUS, keywords: ["differentiation", "integration"] },
    { topicId: 3, tier: "AS", embedding: VEC_VECTORS, keywords: ["vectors", "scalar"] },
    { topicId: 4, tier: "AS", embedding: VEC_QUAD_ISH, keywords: ["inequalities", "quadratic"] },
  ];

  it("returns top-K ordered by cosine score", () => {
    const hits = rankTopicsBySimilarity(VEC_QUADRATICS, "", candidates, { topK: 3 });
    expect(hits.map((h) => h.topicId)).toEqual([1, 4, 2]);
  });

  it("applies keyword boost when query text overlaps keywords", () => {
    // Each candidate gets boost = matches × 0.02 (capped). The boost is meant
    // to break near-ties on cosine score, not override a large cosine gap.
    const hits = rankTopicsBySimilarity(VEC_QUADRATICS, "quadratic inequalities", candidates, { topK: 4 });
    const byId = new Map(hits.map((h) => [h.topicId, h]));
    // Topic 1 keywords = ["quadratic", "equations"] → 1 match → 0.02.
    expect(byId.get(1)!.keywordBoost).toBeCloseTo(0.02);
    // Topic 4 keywords = ["inequalities", "quadratic"] → 2 matches → 0.04.
    expect(byId.get(4)!.keywordBoost).toBeCloseTo(0.04);
    // Topic 2 and 3 don't overlap the query → no boost.
    expect(byId.get(2)!.keywordBoost).toBe(0);
    expect(byId.get(3)!.keywordBoost).toBe(0);
    // Tied cosine breaker: topic 4 now edges topic 1 because the stronger
    // keyword overlap tips a 0.006 cosine gap. This is the designed behaviour.
    expect(hits[0].topicId).toBe(4);
    expect(hits[1].topicId).toBe(1);
  });

  it("is deterministic: ties broken by topicId then tier", () => {
    const tied: RankableTopicEmbedding[] = [
      { topicId: 3, tier: "AS", embedding: VEC_QUADRATICS },
      { topicId: 1, tier: "A2", embedding: VEC_QUADRATICS },
      { topicId: 1, tier: "AS", embedding: VEC_QUADRATICS },
    ];
    const hits = rankTopicsBySimilarity(VEC_QUADRATICS, "", tied, { topK: 3 });
    expect(hits.map((h) => `${h.topicId}:${h.tier}`)).toEqual(["1:A2", "1:AS", "3:AS"]);
  });

  it("respects topK", () => {
    const hits = rankTopicsBySimilarity(VEC_QUADRATICS, "", candidates, { topK: 2 });
    expect(hits).toHaveLength(2);
  });

  it("filters out hits below minScore", () => {
    const hits = rankTopicsBySimilarity(VEC_QUADRATICS, "", candidates, { topK: 10, minScore: 0.5 });
    // Only topic 1 (score=1) and topic 4 (score≈0.994) exceed 0.5.
    expect(hits.map((h) => h.topicId)).toEqual([1, 4]);
  });

  it("caps keyword boost so lexical noise can't dominate", () => {
    const spam: RankableTopicEmbedding[] = [
      { topicId: 99, tier: "AS", embedding: VEC_VECTORS, keywords: Array(100).fill("quadratic") },
      { topicId: 1, tier: "AS", embedding: VEC_QUADRATICS, keywords: ["quadratic"] },
    ];
    const hits = rankTopicsBySimilarity(VEC_QUADRATICS, "quadratic", spam, { topK: 2, maxKeywordBoost: 0.1 });
    // topic 1: cosine 1.0 + boost 0.02 = 1.02. topic 99: cosine 0 + capped boost 0.1.
    // Topic 1 must still lead.
    expect(hits[0].topicId).toBe(1);
    expect(hits[1].keywordBoost).toBeLessThanOrEqual(0.1);
  });

  it("handles empty candidates", () => {
    expect(rankTopicsBySimilarity(VEC_QUADRATICS, "q", [])).toEqual([]);
  });
});
