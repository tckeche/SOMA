import type { GraphQuestionSpec } from "@shared/schema";

export type RawQuestionInput = Record<string, unknown>;

export interface NormalizedQuestionForInsert {
  stem: string;
  options: string[];
  correct_answer: string;
  explanation: string;
  marks: number;
  question_type: string;
  graph_spec: GraphQuestionSpec | null;
  mark_scheme: string | null;
  topic_tag: string | null;
  subtopic_tag: string | null;
  difficulty_tag: string | null;
  target_misconception_ids: number[] | null;
  option_rationales: unknown;
  subtopic_id: number | null;
  learning_requirement_id: number | null;
  command_word: string | null;
  assessment_objective: string | null;
  generation_meta: unknown;
  review_status: string | null;
}
