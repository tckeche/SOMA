import { getTopicContext, listAllSubjectNames, listExaminingBodies, listLevelsForBody, listSubjectsForBodyLevel, listTopics, resolveSyllabus } from "../../services/syllabusCatalogue";
export const listBodies = listExaminingBodies;
export const listPublicSubjectNames = listAllSubjectNames;
export const listLevels = listLevelsForBody;
export const listSubjects = listSubjectsForBodyLevel;
export async function listTopicResponse(body: string, level: string, subject: string) {
  const syllabus = await resolveSyllabus(body, level, subject);
  if (!syllabus) return null;
  const topics = await listTopics(body, level, subject);
  return { syllabus, topics };
}
export const topicContext = getTopicContext;
