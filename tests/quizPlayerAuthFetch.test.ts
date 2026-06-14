/**
 * Regression guard for the "Failed to load quiz" bug.
 *
 * The quiz player loaded the quiz + questions with a bare `fetch()`, which
 * sends no Supabase bearer token. Both endpoints require `requireSupabaseAuth`,
 * so every logged-in student got 401 -> "Failed to load quiz". The fix routes
 * those reads through `authFetch` (like submit / check-submission already do).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";

describe("Quiz player must send the auth token to quiz endpoints", () => {
  const source = fs.readFileSync("client/src/pages/soma-quiz.tsx", "utf8");

  it("never calls the auth-gated quiz endpoints with a bare fetch()", () => {
    // A non-letter before "fetch(" means a bare fetch; "authFetch(" can't match.
    expect(source).not.toMatch(/[^A-Za-z]fetch\(`\/api\/soma\/quizzes/);
  });

  it("loads the quiz and its questions via authFetch", () => {
    expect(source).toMatch(/authFetch\(`\/api\/soma\/quizzes\/\$\{quizId\}`\)/);
    expect(source).toMatch(/authFetch\(`\/api\/soma\/quizzes\/\$\{quizId\}\/questions`\)/);
  });
});
