import { storage } from "../../storage";
import { tutorCanAccessStudent } from "./policies";
import type { z } from "zod";
import type { studentSubjectPayloadSchema } from "./validators";
export class StudentSubjectError extends Error { constructor(public status: number, message: string) { super(message); } }
async function assertAccess(tutorId: string, studentId: string) { if (!(await tutorCanAccessStudent(tutorId, studentId))) throw new StudentSubjectError(403, "Access denied"); }
export async function list(tutorId: string, studentId: string) { await assertAccess(tutorId, studentId); return storage.listStudentSubjects(studentId); }
export async function add(tutorId: string, studentId: string, payload: z.infer<typeof studentSubjectPayloadSchema>) { await assertAccess(tutorId, studentId); return storage.addStudentSubject({ studentId, ...payload }); }
export async function update(tutorId: string, studentId: string, subjectId: number, payload: z.infer<typeof studentSubjectPayloadSchema>) { await assertAccess(tutorId, studentId); return storage.updateStudentSubject(subjectId, studentId, payload); }
export async function remove(tutorId: string, studentId: string, subjectId: number) { await assertAccess(tutorId, studentId); await storage.deleteStudentSubject(subjectId, studentId); return { deleted: true }; }
