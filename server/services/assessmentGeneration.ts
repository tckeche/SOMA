import { z } from "zod";
import { graphQuestionSpecSchema } from "@shared/schema";
import type { GraphQuestionSpec } from "@shared/schema";

// Re-export the canonical schema so all imports use the same definition
// (the old local schema was missing the `curves` field, which caused silent data loss)
export const graphSpecSchema = graphQuestionSpecSchema;

export const copilotDraftSchema = z.object({
  prompt_text: z.string(),
  options: z.array(z.string()).length(4),
  correct_answer: z.string(),
  marks_worth: z.number().int().min(1).max(10),
  explanation: z.string().min(1),
  topic_tag: z.string().optional(),
  subtopic_tag: z.string().optional(),
  difficulty_tag: z.string().optional(),
  question_type: z.enum(["multiple_choice", "graph"]).default("multiple_choice"),
  graph_spec: graphSpecSchema.optional(),
});

export const copilotResponseSchema = z.object({
  reply: z.string().min(1),
  drafts: z.array(copilotDraftSchema).default([]),
  summary: z.object({
    numberOfQuestionsAdded: z.number().int().min(0),
    questionTypesUsed: z.array(z.string()).default([]),
    topicsCovered: z.array(z.string()).default([]),
    subtopicsCovered: z.array(z.string()).default([]),
    difficultyMix: z.array(z.string()).default([]),
    syllabusContextUsed: z.array(z.string()).default([]),
  }),
});

export type CopilotDraft = z.infer<typeof copilotDraftSchema>;
export type CopilotResponse = z.infer<typeof copilotResponseSchema>;

export function buildSyllabusChunks(text: string, maxChunkLength = 900): Array<{ chunkIndex: number; content: string; contentPreview: string }> {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const chunks: Array<{ chunkIndex: number; content: string; contentPreview: string }> = [];
  let current = "";
  for (const sentence of sentences) {
    if (!sentence) continue;
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > maxChunkLength && current) {
      chunks.push({ chunkIndex: chunks.length, content: current, contentPreview: current.slice(0, 140) });
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current) {
    chunks.push({ chunkIndex: chunks.length, content: current, contentPreview: current.slice(0, 140) });
  }
  return chunks;
}

// Math/science synonym clusters for semantic matching
const SYNONYM_MAP: Record<string, string[]> = {
  differentiation: ["derivative", "calculus", "gradient", "tangent", "rate of change"],
  integration: ["integral", "antiderivative", "area under curve", "calculus"],
  algebra: ["equation", "expression", "variable", "polynomial", "factoring", "factorisation"],
  geometry: ["shape", "angle", "triangle", "circle", "polygon", "area", "perimeter"],
  trigonometry: ["sine", "cosine", "tangent", "trig", "sin", "cos", "tan"],
  statistics: ["probability", "mean", "median", "mode", "standard deviation", "data"],
  quadratic: ["parabola", "completing the square", "quadratic formula", "factoring"],
  logarithm: ["logarithmic", "log", "exponent", "exponential", "indices"],
  matrix: ["matrices", "determinant", "transformation", "linear algebra"],
  vector: ["vectors", "magnitude", "direction", "scalar product", "dot product"],
  sequence: ["series", "arithmetic", "geometric", "progression", "term"],
  function: ["domain", "range", "mapping", "transformation", "inverse"],
  fraction: ["ratio", "proportion", "percentage", "decimal"],
  simultaneous: ["system of equations", "linear equations", "elimination", "substitution"],
  inequality: ["inequalities", "number line", "region", "boundary"],
  coordinate: ["cartesian", "graph", "axes", "plotting", "gradient"],
  mensuration: ["volume", "surface area", "capacity", "measurement"],
  sets: ["venn diagram", "intersection", "union", "subset", "element"],
  probability: ["chance", "likelihood", "expected", "tree diagram", "outcome"],
  number: ["integer", "rational", "irrational", "prime", "factor", "multiple"],
};

function expandQueryTerms(query: string): { unigrams: string[]; bigrams: string[]; synonyms: string[] } {
  const lower = query.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const unigramSet = new Set(words);
  const bigramSet = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    bigramSet.add(`${words[i]} ${words[i + 1]}`);
  }
  const synonymSet = new Set<string>();
  for (const word of words) {
    if (SYNONYM_MAP[word]) {
      for (const syn of SYNONYM_MAP[word]) synonymSet.add(syn);
    }
    // Reverse lookup: if the word appears in any synonym list, add the key
    for (const [key, syns] of Object.entries(SYNONYM_MAP)) {
      if (syns.includes(word) && !unigramSet.has(key)) synonymSet.add(key);
    }
  }
  return { unigrams: Array.from(unigramSet), bigrams: Array.from(bigramSet), synonyms: Array.from(synonymSet) };
}

export function scoreSyllabusChunks(chunks: Array<{ content: string }>, query: string, limit = 4): string[] {
  if (chunks.length === 0 || !query.trim()) return [];

  const { unigrams, bigrams, synonyms } = expandQueryTerms(query);

  // Compute document frequency for IDF weighting
  const docFreq: Record<string, number> = {};
  for (const chunk of chunks) {
    const hay = chunk.content.toLowerCase();
    const seen = new Set<string>();
    for (const term of unigrams) {
      if (!seen.has(term) && hay.includes(term)) { docFreq[term] = (docFreq[term] || 0) + 1; seen.add(term); }
    }
  }
  const N = chunks.length;

  return chunks
    .map((chunk) => {
      const hay = chunk.content.toLowerCase();
      let score = 0;

      // Unigram matches with IDF weighting
      for (const term of unigrams) {
        if (hay.includes(term)) {
          const idf = Math.log((N + 1) / ((docFreq[term] || 0) + 1)) + 1;
          // Count occurrences for term frequency
          const count = hay.split(term).length - 1;
          const tf = 1 + Math.log(Math.max(1, count));
          score += tf * idf;
        }
      }

      // Bigram matches score higher (phrase matching)
      for (const bigram of bigrams) {
        if (hay.includes(bigram)) score += 3;
      }

      // Synonym matches add partial credit
      for (const syn of synonyms) {
        if (hay.includes(syn)) score += 0.5;
      }

      // Boost for early mention (likely topic headers/titles)
      const firstMention = Math.min(
        ...Array.from(unigrams).map((t) => { const idx = hay.indexOf(t); return idx >= 0 ? idx : Infinity; })
      );
      if (firstMention < 100) score *= 1.3;

      return { content: chunk.content, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.content);
}

function shuffleArray<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function balanceAnswerOptions<T extends { options: string[]; correct_answer: string }>(questions: T[]): T[] {
  const targetPositions = shuffleArray(questions.map((_, index) => index % 4));
  return questions.map((question, index) => {
    const correct = question.correct_answer;
    const distractors = shuffleArray(question.options.filter((option) => option !== correct));
    const desiredIndex = targetPositions[index];
    const nextOptions = [...distractors];
    nextOptions.splice(desiredIndex, 0, correct);
    return { ...question, options: nextOptions, correct_answer: correct };
  });
}

export function buildCopilotSummary(input: {
  drafts: Array<Partial<CopilotDraft>>;
  syllabusContextLabel?: string | null;
}): CopilotResponse["summary"] {
  const topics = new Set<string>();
  const subtopics = new Set<string>();
  const difficulties = new Set<string>();
  const questionTypes = new Set<string>();

  for (const draft of input.drafts) {
    if (draft.topic_tag) topics.add(draft.topic_tag);
    if (draft.subtopic_tag) subtopics.add(draft.subtopic_tag);
    if (draft.difficulty_tag) difficulties.add(draft.difficulty_tag);
    questionTypes.add(draft.question_type || (draft.graph_spec ? "graph" : "multiple_choice"));
  }

  return {
    numberOfQuestionsAdded: input.drafts.length,
    questionTypesUsed: Array.from(questionTypes),
    topicsCovered: Array.from(topics),
    subtopicsCovered: Array.from(subtopics),
    difficultyMix: Array.from(difficulties),
    syllabusContextUsed: input.syllabusContextLabel ? [input.syllabusContextLabel] : [],
  };
}
