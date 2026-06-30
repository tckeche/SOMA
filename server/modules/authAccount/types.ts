export type SomaRole = "tutor" | "student" | "super_admin";

export interface AuthMetadata {
  display_name?: string;
  full_name?: string;
  requested_role?: string;
  subject?: string;
  syllabus?: string;
  syllabus_code?: string;
  level?: string;
  subjects?: Array<{ subject: string; examBody: string; syllabusCode: string; level: string }>;
}
