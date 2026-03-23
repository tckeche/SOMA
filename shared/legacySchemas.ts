import { z } from "zod";

export const insertQuizSchema = z.object({
  title: z.string().min(1),
  timeLimitMinutes: z.number().int().positive(),
  dueDate: z.coerce.date(),
});

export const insertQuestionSchema = z.object({
  quizId: z.number().int().positive(),
  promptText: z.string().min(1),
  imageUrl: z.string().nullable().optional(),
  options: z.array(z.string()).length(4),
  correctAnswer: z.string().min(1),
  marksWorth: z.number().int().positive().default(1),
});

export const insertStudentSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
});

export const insertSubmissionSchema = z.object({
  studentId: z.number().int().positive(),
  quizId: z.number().int().positive(),
  answers: z.record(z.coerce.number().int()),
  score: z.number().int().nonnegative(),
  startedAt: z.date().optional(),
  submittedAt: z.date().optional(),
});

export const questionUploadSchema = z.array(z.object({
  prompt_text: z.string().min(1),
  image_url: z.string().nullable().optional(),
  options: z.array(z.string().min(1)).length(4),
  correct_answer: z.string().min(1),
  marks_worth: z.number().int().positive().optional().default(1),
}));

export type InsertQuiz = z.infer<typeof insertQuizSchema>;
export type InsertQuestion = z.infer<typeof insertQuestionSchema>;
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type InsertSubmission = z.infer<typeof insertSubmissionSchema>;
