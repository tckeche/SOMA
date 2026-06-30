import crypto from "crypto";
import type { Request, Response } from "express";
import { storage } from "../../storage";
import type { SomaReadAuthUser } from "./types";

function hashIdentifier(value: string | undefined) {
  return value ? crypto.createHash("sha256").update(value).digest("hex") : undefined;
}

export function logSomaPermissionDenied(params: { route: string; quizId?: number; userId?: string; role?: string | null; reason: string }) {
  const { userId, ...safeParams } = params;
  console.warn(JSON.stringify({ event: "permission_denied", resource: "soma_quiz", ...safeParams, userHash: hashIdentifier(userId) }));
}

export async function canReadSomaQuiz(quiz: any, authUser: SomaReadAuthUser): Promise<boolean> {
  const userId = String(authUser.id);
  if (authUser.role === "super_admin") return true;
  if (authUser.role === "tutor") return quiz.authorId === userId;
  const assignments = await storage.getQuizAssignmentsForStudent(userId);
  return assignments.some((assignment) => assignment.quizId === quiz.id);
}

export async function requireSomaQuizReadAccess(req: Request, res: Response, quiz: any): Promise<boolean> {
  const authUser = (req as any).authUser as SomaReadAuthUser;
  const allowed = await canReadSomaQuiz(quiz, authUser);
  if (!allowed) {
    logSomaPermissionDenied({
      route: req.path,
      quizId: quiz.id,
      userId: String(authUser.id),
      role: authUser.role,
      reason: "soma_quiz_not_assigned_or_not_owned",
    });
    res.status(403).json({ message: "Forbidden: you do not have access to this quiz" });
    return false;
  }
  return true;
}
