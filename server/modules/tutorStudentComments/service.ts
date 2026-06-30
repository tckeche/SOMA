import { storage } from "../../storage";
import { tutorCanAccessStudent } from "./policies";
export class TutorCommentError extends Error { constructor(public status: number, message: string) { super(message); } }
async function assertAccess(tutorId: string, studentId: string) { if (!(await tutorCanAccessStudent(tutorId, studentId))) throw new TutorCommentError(403, "Access denied"); }
export async function list(tutorId: string, studentId: string) { await assertAccess(tutorId, studentId); return storage.getTutorComments(tutorId, studentId); }
export async function add(tutorId: string, studentId: string, comment: string) { await assertAccess(tutorId, studentId); return storage.addTutorComment({ tutorId, studentId, comment }); }
