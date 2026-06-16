---
name: Tutor analytics endpoints must verify student adoption
description: Any tutor endpoint that fetches per-student server-side data must gate on the adopted-student set, never trust client-supplied studentIds.
---

# Tutor analytics authorization (IDOR guard)

Any tutor-facing endpoint that takes a `studentId` (or a list of them) from the
request body/query and then fetches that student's server-side academic data
(mastery, reports, syllabus insights, summaries) MUST first resolve the
requesting tutor's adopted students (`storage.getAdoptedStudents(tutorId)`) and
filter/reject any id outside that set.

**Why:** `POST /api/tutor/ai/intervention-insights` originally only echoed
client-supplied fields, so it was safe. When it was changed to enrich each
student with `listStudentTopicMastery` / `buildSyllabusInsights` keyed by the
client-supplied `studentId`, it became an IDOR — a tutor could submit arbitrary
ids and extract another tutor's students' weakness data through the AI output.

**How to apply:** Before any per-student server fetch in a tutor route, build
`new Set((await storage.getAdoptedStudents(tutorId)).map(s => s.id))` and drop
ids not in it. Treat "client sends an id we then look up server-side" as the
trigger, regardless of whether the response feels low-sensitivity.
