import { storage } from "../../storage";
export async function tutorCanAccessStudent(tutorId: string, studentId: string) { const adopted = await storage.getAdoptedStudents(tutorId); return adopted.some((s) => s.id === studentId); }
