/**
 * Tests for the SOMA 3-way disagreement protocol + per-option rationale
 * integrity check.
 *
 * The protocol replaces the old "snap to options[0] when nothing matches"
 * silent-coerce behaviour with: vote between maker / verifier / deterministic
 * prover, and BLOCK any question we can't confidently mark correct.
 *
 * The rationale validator drops malformed per-option rationale arrays
 * (wrong length, mis-aligned options, multiple isCorrect rows, fake
 * misconception ids) before they reach persistence.
 */
import { describe, it, expect } from "vitest";

import {
  applyDisagreementProtocol,
  validateOptionRationales,
  type PipelineWarning,
  type QuizResult,
} from "../server/services/aiPipeline";

// A non-mathematical question — the math prover cannot verify it, so the
// protocol relies on maker/verifier consensus only.
const proseQuestion: QuizResult["questions"][number] = {
  stem: "Which scientist proposed the theory of natural selection?",
  options: ["Darwin", "Newton", "Einstein", "Curie"],
  correct_answer: "Darwin",
  explanation: "Darwin published On the Origin of Species in 1859.",
  marks: 1,
};

const proseDraft = {
  stem: proseQuestion.stem,
  options: proseQuestion.options,
  correct_answer: "Darwin",
  marks: 1,
};

// A math question whose stem the validator can re-solve. "What is 2 + 2?"
// matches the basic arithmetic pattern → prover returns "4".
const mathQuestion: QuizResult["questions"][number] = {
  stem: "What is $2 + 2$?",
  options: ["2", "3", "4", "5"],
  correct_answer: "4",
  explanation: "Two plus two equals four.",
  marks: 1,
};

const mathDraft = { stem: mathQuestion.stem, options: mathQuestion.options, correct_answer: "4", marks: 1 };

// ─── Disagreement protocol ─────────────────────────────────────────────────

describe("applyDisagreementProtocol", () => {
  it("ships a question when maker, verifier, and prover all agree", () => {
    const result = applyDisagreementProtocol([mathDraft], [mathQuestion], []);
    expect(result.questions).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("blocks a question when the prover disagrees with the verifier", () => {
    // Verifier says "5" but the prover re-solves 2+2 and matches "4".
    const wrongVerified: QuizResult["questions"][number] = { ...mathQuestion, correct_answer: "5" };
    const result = applyDisagreementProtocol([mathDraft], [wrongVerified], []);
    expect(result.questions).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toMatch(/prover disagreed with verifier/i);
    expect(result.blocked[0].votes.prover).toBe("4");
    expect(result.blocked[0].votes.verifier).toBe("5");
  });

  it("ships a non-math question when both LLMs agree (no prover available)", () => {
    const result = applyDisagreementProtocol([proseDraft], [proseQuestion], []);
    expect(result.questions).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("ships and emits an info warning when the verifier overrode the maker (prose, no prover)", () => {
    const draft = { ...proseDraft, correct_answer: "Newton" };
    const result = applyDisagreementProtocol([draft], [proseQuestion], []);
    expect(result.questions).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].issue).toMatch(/Verifier disagreed with maker/);
    expect(result.warnings[0].issue).toMatch(/no prover available/);
  });

  it("ships a math question when verifier overrode the maker AND prover agrees with verifier", () => {
    const wrongDraft = { ...mathDraft, correct_answer: "5" };
    const result = applyDisagreementProtocol([wrongDraft], [mathQuestion], []);
    expect(result.questions).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].issue).toMatch(/prover.*agrees with verifier/);
  });

  it("blocks a question that arrived with an unfixed CRITICAL upstream warning", () => {
    const upstream: PipelineWarning[] = [
      {
        questionIndex: 1,
        field: "correct_answer",
        issue: "CRITICAL: verifier's correct_answer does not match ANY of the 4 options.",
        autoFixed: false,
      },
    ];
    const result = applyDisagreementProtocol([proseDraft], [proseQuestion], upstream);
    expect(result.questions).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toMatch(/failed integrity checks/i);
  });

  it("does not double-block a question that has both a CRITICAL warning and prover disagreement", () => {
    const upstream: PipelineWarning[] = [
      {
        questionIndex: 1,
        field: "correct_answer",
        issue: "CRITICAL: verifier's correct_answer does not match ANY of the 4 options.",
        autoFixed: false,
      },
    ];
    const wrongVerified: QuizResult["questions"][number] = { ...mathQuestion, correct_answer: "5" };
    const result = applyDisagreementProtocol([mathDraft], [wrongVerified], upstream);
    expect(result.blocked).toHaveLength(1);
  });

  it("processes a mixed batch: ships some, blocks others, in original order", () => {
    const wrongMath: QuizResult["questions"][number] = { ...mathQuestion, correct_answer: "5" };
    const result = applyDisagreementProtocol(
      [proseDraft, mathDraft, mathDraft],
      [proseQuestion, mathQuestion, wrongMath],
      [],
    );
    expect(result.questions).toHaveLength(2);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].originalIndex).toBe(3);
  });

  it("does not block when an autoFixed warning exists (autoFix already handled it)", () => {
    const upstream: PipelineWarning[] = [
      {
        questionIndex: 1,
        field: "correct_answer",
        issue: "Verifier returned bare letter 'A' instead of option text; mapped automatically.",
        autoFixed: true,
      },
    ];
    const result = applyDisagreementProtocol([proseDraft], [proseQuestion], upstream);
    expect(result.questions).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  // ── Independent blind-solver vote (opt-in 4th arg) ──────────────────────────

  it("blocks a non-math question when the independent blind solver disagrees", () => {
    const solverVotes = new Map([
      [1, { chosenOption: "Newton", multipleCorrect: false }],
    ]);
    const result = applyDisagreementProtocol([proseDraft], [proseQuestion], [], solverVotes);
    expect(result.questions).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toMatch(/Independent blind solver disagreed/i);
    expect(result.blocked[0].reason).toMatch(/solver="Newton"/);
    expect(result.blocked[0].reason).toMatch(/verifier="Darwin"/);
  });

  it("keeps a non-math question when the independent blind solver agrees", () => {
    const solverVotes = new Map([
      [1, { chosenOption: "Darwin", multipleCorrect: false }],
    ]);
    const result = applyDisagreementProtocol([proseDraft], [proseQuestion], [], solverVotes);
    expect(result.questions).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  it("blocks a non-math question when the solver flags multiple defensible answers", () => {
    const solverVotes = new Map([
      [1, { chosenOption: "Darwin", multipleCorrect: true }],
    ]);
    const result = applyDisagreementProtocol([proseDraft], [proseQuestion], [], solverVotes);
    expect(result.questions).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toMatch(/more than one defensible correct option/i);
  });

  it("ignores the solver vote for math-verifiable questions (prover is authoritative)", () => {
    // Solver picks the wrong option, but the deterministic prover can re-solve
    // 2+2 and agrees with the verifier ("4"), so the solver vote is ignored.
    const solverVotes = new Map([
      [1, { chosenOption: "5", multipleCorrect: false }],
    ]);
    const result = applyDisagreementProtocol([mathDraft], [mathQuestion], [], solverVotes);
    expect(result.questions).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  it("behaves identically to the 3-arg call when no solverVotes are supplied", () => {
    const withArg = applyDisagreementProtocol([proseDraft], [proseQuestion], [], undefined);
    const withoutArg = applyDisagreementProtocol([proseDraft], [proseQuestion], []);
    expect(withArg).toEqual(withoutArg);
    expect(withArg.questions).toHaveLength(1);
    expect(withArg.blocked).toHaveLength(0);
  });
});

// ─── Per-option rationale validator ────────────────────────────────────────

const goodRationales = [
  { option: "Darwin", isCorrect: true, rationale: "Right person.", misconceptionId: null },
  { option: "Newton", isCorrect: false, rationale: "Newton studied gravity, not evolution.", misconceptionId: 11 },
  { option: "Einstein", isCorrect: false, rationale: "Einstein worked on relativity.", misconceptionId: null },
  { option: "Curie", isCorrect: false, rationale: "Curie studied radioactivity.", misconceptionId: null },
];

describe("validateOptionRationales", () => {
  it("passes a well-formed rationale array unchanged when ids are on the approved list", () => {
    const q = { ...proseQuestion, option_rationales: goodRationales };
    const approved = new Set([11]);
    const result = validateOptionRationales([q], approved);
    expect(result.warnings).toHaveLength(0);
    expect(result.questions[0].option_rationales).toEqual(goodRationales);
  });

  it("strips misconception ids that aren't on the approved list", () => {
    const q = { ...proseQuestion, option_rationales: goodRationales };
    const approved = new Set<number>(); // empty → all ids stripped
    const result = validateOptionRationales([q], approved);
    expect(result.questions[0].option_rationales?.[1].misconceptionId).toBeNull();
  });

  it("drops the rationale array when length != 4", () => {
    const q = { ...proseQuestion, option_rationales: goodRationales.slice(0, 3) };
    const result = validateOptionRationales([q], new Set());
    expect(result.questions[0].option_rationales).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].issue).toMatch(/4 rows/);
  });

  it("drops the rationale array when an option text isn't covered", () => {
    const broken = goodRationales.map((r, i) => i === 1 ? { ...r, option: "Newt0n" /* typo */ } : r);
    const q = { ...proseQuestion, option_rationales: broken };
    const result = validateOptionRationales([q], new Set());
    expect(result.questions[0].option_rationales).toBeUndefined();
    expect(result.warnings[0].issue).toMatch(/does not cover option/);
  });

  it("drops the rationale array when more than one row is isCorrect", () => {
    const broken = goodRationales.map((r, i) => i === 1 ? { ...r, isCorrect: true } : r);
    const q = { ...proseQuestion, option_rationales: broken };
    const result = validateOptionRationales([q], new Set());
    expect(result.questions[0].option_rationales).toBeUndefined();
    expect(result.warnings[0].issue).toMatch(/exactly one isCorrect/);
  });

  it("drops the rationale array when isCorrect labels a different option than correct_answer", () => {
    const broken = [
      { ...goodRationales[0], isCorrect: false },
      { ...goodRationales[1], isCorrect: true },
      goodRationales[2],
      goodRationales[3],
    ];
    const q = { ...proseQuestion, option_rationales: broken };
    const result = validateOptionRationales([q], new Set([11]));
    expect(result.questions[0].option_rationales).toBeUndefined();
    expect(result.warnings[0].issue).toMatch(/labels.*but correct_answer is/);
  });

  it("reorders rationales to match options[] order", () => {
    const shuffled = [goodRationales[2], goodRationales[0], goodRationales[3], goodRationales[1]];
    const q = { ...proseQuestion, option_rationales: shuffled };
    const result = validateOptionRationales([q], new Set([11]));
    expect(result.questions[0].option_rationales?.map((r) => r.option)).toEqual([
      "Darwin", "Newton", "Einstein", "Curie",
    ]);
  });

  it("leaves questions without rationales untouched", () => {
    const result = validateOptionRationales([proseQuestion], new Set());
    expect(result.warnings).toHaveLength(0);
    expect(result.questions[0]).toEqual(proseQuestion);
  });
});
