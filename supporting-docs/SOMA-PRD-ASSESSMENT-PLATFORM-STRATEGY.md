# soma — Product Requirements Document & Implementation Plan

**Document owner:** Product Strategy
**Status:** Draft v1.0
**Date:** 2026-04-19
**Scope:** Improvements to the soma assessment platform covering tutor, student, admin, and super admin workflows.

---

## 1. Product Vision Summary

soma is an education assessment platform that helps tutors assign high-quality assessments to individual students and small groups, helps students complete those assessments clearly and confidently, and generates immediate, diagnostic feedback that drives the next learning step.

This release sharpens soma around three outcomes:

1. **Tutor efficiency.** Creating, assigning, and reviewing assessments must be fast and trustworthy, even for a tutor with a single student.
2. **Student clarity.** The student experience must make it obvious what to do next — whether that is a new assessment, an unfinished one to resume, or feedback to review.
3. **Actionable feedback.** soma automatically generates diagnostic feedback the moment a quiz is submitted, so learning momentum is never blocked on tutor availability.

Individual students remain the default. Groups are an optional convenience for tutors managing cohorts such as an IGCSE Maths group or Saturday revision group. soma is not becoming a class-first or school-first platform.

The product must feel reliable (autosave, draft recovery, resilient Co-Pilot generation), professional (properly rendered maths, real PDF reports, consistent terminology), and classroom-ready on any device — especially mobile phones, where many students will complete quizzes.

---

## 2. Key User Roles

### Student
A learner assigned assessments by one or more tutors. Completes quizzes, reads soma-generated feedback, and tracks progress against syllabus coverage. Mostly on mobile or tablet.

### Tutor
The primary power user. Manages individual students (and optionally groups), creates assessments with Co-Pilot, assigns them, monitors status, reviews results, and intervenes when the data flags a concern. Mostly on laptop or desktop, sometimes tablet.

### Admin
A tutor who has been elevated by the super admin. Retains all tutor capabilities and gains admin tooling. Uses an explicit **View as Tutor / View as Admin** toggle so mode is never ambiguous. All admin actions are audit-logged.

### Super Admin
Platform-level operator. Elevates tutors to admin, views full audit history across tutors, assessments, assignments, submissions, and reports, and investigates issues. Cannot be impersonated or hidden from.

---

## 3. Feature Requirements

### 3.1 Student Management — Individual First, Optional Groups

**Individual students (default view)**

The Students page opens on an individual student list. A tutor with one student must feel just as well-served as a tutor with fifty.

Each student row/card shows:
- Student name
- Student email (always visible — required for searchable selection)
- Level (e.g. IGCSE, AS, A Level, KS3)
- Subjects, if available
- Last active date/time
- Number of assigned assessments
- Number of completed assessments
- Basic progress indicator (e.g. completion % or a small bar)
- **View** button
- **Remove** action (with confirmation; does not delete the student account or their historical submissions)

The list supports free-text search across **name and email** and filtering by level and subject.

**Optional groups**

Groups are a secondary, opt-in organisational layer. A tutor must never be forced into a group to assign work.

Tutors can:
- Create a group with a name (e.g. "IGCSE Maths group", "AS Physics group", "Saturday tutoring group")
- Rename a group
- Add one or more existing students to a group
- Remove a student from a group without deleting the student or their submissions
- Assign one assessment to a group (assignment fans out to each member)
- View aggregate group performance (average score, completion rate, weakest topics)
- Drill into any individual student from within the group view

A student can belong to more than one group (e.g. "AS Physics group" and "Saturday tutoring group").

### 3.2 Assessment Creation — Co-Pilot Driven

Assessment creation is Co-Pilot-driven end-to-end. There is **no separate manual question editor** in this release — edits happen through natural-language instructions to soma.

Creation steps:
1. Title
2. Subject (required)
3. Level (required)
4. Syllabus (optional, e.g. Cambridge)
5. Topics (optional, multi-select — see 3.4)
6. Template type (optional — see 3.3)
7. Co-Pilot prompt (optional free text)
8. Time limit (optional)
9. Generate → review → refine via Co-Pilot → publish

### 3.3 Co-Pilot Assessment Templates

Template selection lives **inside** the Co-Pilot phase of creation — not in a separate template library.

Options (all optional):
- **Mixed revision quiz** — balanced coverage across selected topics.
- **Diagnostic test** — designed to surface strengths and weaknesses.
- **Homework check** — short and focused, typically one topic.
- **Exam-style mini paper** — formal wording, marks shown, exam-style phrasing matched to the syllabus.

The chosen template shapes the Co-Pilot system prompt (question count, tone, mark scheme, difficulty distribution). The tutor can still type a custom prompt. If no template is chosen, soma generates from subject, level, topics, and prompt alone.

### 3.4 Topic Selection — Subject × Level × Syllabus

After subject, level, and syllabus are chosen, an optional **Topics** dropdown (multi-select) appears. Topics are sourced from the selected syllabus mapping (e.g. Cambridge IGCSE Mathematics → Algebra, Linear equations, Graphs, Geometry, Trigonometry, Mensuration, Probability, Statistics).

Rules:
- Topic selection is always optional.
- Ordering is fixed: **Subject → Level → Syllabus → Topics**.
- If no syllabus mapping exists for the chosen subject/level, the field is hidden or shown as "No topics available — generate from prompt instead."
- Selected topics propagate to: assessment generation, feedback, per-student reports, syllabus coverage tracking, and the radar graph.

### 3.5 Student Dashboard — Assignment-First

The student dashboard prioritises action, not decoration. Sections, in order:

1. **Due now** — assessments due today or already overdue.
2. **Upcoming** — assessments with a future due date.
3. **Feedback ready** — completed assessments with soma feedback waiting to be read.
4. **Recommended revision** — soma-suggested next practice based on weak topics.
5. **Completed work** — historical record.

A **radar-style syllabus coverage graph** appears on the dashboard showing coverage by topic (e.g. Algebra, Geometry, Trigonometry, Statistics, Probability). Coverage is derived from completed assessments and topic tags, and highlights gaps at a glance.

Feedback is always generated by soma immediately on submission — the dashboard never implies the student is waiting on the tutor.

### 3.6 Notifications

Notifications are short, colour-coded, icon-coded, and actionable.

| Type | Colour | Icon | Example copy |
|---|---|---|---|
| New assessment assigned | Blue | Bell | "New assessment: Algebra Basics." |
| Due soon | Amber | Clock | "Algebra Basics is due tomorrow." |
| Due today | Amber | Clock | "Algebra Basics is due today." |
| Overdue | Red | Warning | "Chemistry Bonding is overdue." |
| Feedback ready | Green | Sparkle | "Feedback ready: Algebra Basics." |
| Assessment resumed / unfinished | Purple | Progress | "You have an unfinished assessment: Algebra Basics. Resume now." |
| Autosave issue | Red | Cloud warning | "We couldn't save your last answer. Check your connection." |

Do not rely on colour alone — every notification also carries an icon and explicit text.

### 3.7 Assessment-Taking Experience

**Start screen (short, reassuring):**
- Title, subject, level
- Topics covered (if selected)
- Number of questions, total marks
- Time limit
- Due date (if applicable)
- Short instructions
- Calculator / formula sheet rule (if relevant)
- **Start Assessment** button

Do not include explanations about skipping, returning to previous questions, or feedback timing on this screen.

**In-quiz UI:**
- Question, answer options, flag/skip controls
- Timer (visible on mobile without covering answers)
- Progress indicator
- Subtle autosave indicator (see 3.8)

### 3.8 Autosave and Resume

soma autosaves:
- Selected answers
- Skipped questions
- Flagged questions
- Current question index
- Time elapsed (total)
- Time spent per question

Save indicator states: **Saving…**, **Saved just now**, **Last saved 20 seconds ago**.

Resume: if the student loses connection, refreshes, closes the browser, or navigates away, re-entering the assessment restores exact state (current question, answers, flags, elapsed time). A persistent "unfinished assessment" notification surfaces on the dashboard.

### 3.9 Feedback and Review (soma-generated, immediate)

There is no tutor comment area in the core workflow. Feedback is produced by soma at submission.

**Overall feedback** includes:
- Score, percentage, performance label (e.g. Strong / Developing / Needs revision)
- What the student did well
- Which topics were weak
- Careless vs conceptual mistake breakdown
- Suggested revision task
- Suggested follow-up assessment
- Confidence indicator if soma is uncertain

**Per-question review** shows, for every question:
- The question
- Student's selected answer
- Correct answer
- Correct / incorrect / skipped status
- Explanation of the correct method
- Why the selected answer was wrong (when inferable)
- Likely misconception
- Suggested next step

### 3.10 Tutor Review and Intervention

Automatic flags:
- Low scores
- Repeated mistakes in the same topic
- Many skipped questions
- Very fast careless attempts
- Very slow attempts suggesting struggle
- Started-but-not-submitted
- Overdue
- Sudden drops in performance
- Questions flagged by the student

From a flag the tutor can:
- See the reason and the relevant result/questions
- Assign follow-up practice
- Mark the issue "for discussion outside the app"
- Dismiss as resolved

Explicitly **not included**: in-app messaging to students, notes sent to students, chat.

### 3.11 Assignment Status and Time-Per-Question

Per-student assignment statuses: **Assigned, Seen, Started, In progress, Submitted, Feedback ready, Overdue, Not opened**.

Time-per-question is colour-coded:
- **Green** — reasonable time
- **Amber** — unusually slow
- **Red** — extremely slow or extremely fast
- **Grey** — skipped / not answered

Time data appears in the student report, tutor review, downloadable PDF, and copy summary.

### 3.12 Reports and Exports

Exactly two export options: **Download PDF** and **Copy summary**. No email, parent share, CSV, or external integrations in this release.

**PDF report contents:**
- Company logo
- Student name, tutor name
- Assessment title, subject, level, syllabus, topics covered
- Date report generated, date assessment completed
- Score, percentage, marks achieved / total marks
- Time taken, time spent per question
- Question-by-question breakdown (student answer, correct answer, soma explanation)
- Topic strengths, topic weaknesses
- Suggested revision, suggested follow-up assessment
- Syllabus coverage summary
- Radar-style syllabus coverage graph (if available)

PDF must be a structured document, not a screenshot. Date must be clearly displayed and the report must be parent-shareable.

**Copy summary** produces a clean plain-text block suitable for pasting into email or notes — no markup artefacts.

### 3.13 Maths and Symbol Rendering

Maths rendering must be robust everywhere the platform shows content: questions, options, Co-Pilot output, explanations, student review, tutor review, PDF, copy summary, dashboard suggestions, tips carousel, and notifications containing maths.

Supported: fractions, exponents, square roots, Greek letters, inequalities, algebraic expressions, geometry notation, SI units, chemical formulas, physics notation.

Must not appear: raw `$x$`, unrendered `\( x \)`, broken superscripts/fractions, mis-rendered minus signs, misplaced brackets, escaped characters.

### 3.14 Mobile Responsiveness

Every surface must work on phones, tablets, laptops, and desktops. Priority surfaces to test and harden: student dashboard, tutor dashboard, Add Students modal, optional groups, assessment-taking screen, answer selection, timer, review screen, PDF download, notifications.

Forbidden: horizontal scrolling, tiny buttons, overlapping cards, hidden submit buttons, over-tall modals, fixed elements covering answer options.

### 3.15 Accessibility and Touch Usability

- Large tap areas for checkboxes and answer options
- Clear hover, selected, and focus states
- Strong text contrast (WCAG AA minimum)
- Visible keyboard focus rings
- Generous spacing between **View** and destructive actions
- Screen-reader labels for all icons
- Explicit button labels (no icon-only destructive buttons)
- Never rely on colour alone to convey status

### 3.16 Admin and Audit History

Super admin can view audit history covering: tutor activity, assessment creation, assignment history, student submissions, report generation, and who created/edited/assigned/deleted what, with timestamps.

Super admin can elevate tutors to admin. An elevated user gets a **View as Tutor / View as Admin** toggle. The toggle state is prominent and persistent so admins never act in the wrong role by accident. All admin-mode actions are written to audit history.

### 3.17 AI Trust and Content Checks

Every generated assessment / question carries machine-produced metadata:
- Subject match, level match, syllabus match, topic match
- Difficulty estimate, estimated time per question
- Correct-answer check, explanation check
- Confidence indicator; warning surfaced if confidence is low
- "Reviewed by tutor" status (tutor attestation)

Tutors can ask soma, in natural language:
- "Check this assessment for errors."
- "Is this suitable for IGCSE?"
- "Does this match the Cambridge syllabus?"
- "Are the correct answers accurate?"
- "Make this more exam-style."
- "Check for duplicate answer options."
- "Check for ambiguous wording."

**Question validity checker (Gemini)**

Before publishing, each generated question is checked by a Gemini-based validator service. The checker runs per question and returns structured pass/fail signals plus reasons. A quiz-level pass requires all mandatory checks to pass for all questions.

Per-question checks:
- At least one answer is correct (single-answer questions must have exactly one correct option).
- Duplicate answer options are not present.
- Explanation does not contradict the marked correct answer.
- Subject/level/syllabus/topic alignment is acceptable.
- Maths/symbol rendering is valid (no broken LaTeX/plain-text artefacts).
- Wording is not ambiguous beyond threshold (checker confidence + ambiguity flag).

Quiz-level checks:
- Question set is internally consistent with selected subject/level/syllabus/topics.
- No unresolved failed questions remain.
- Overall checker confidence clears a minimum threshold.

Publishing remains available, but validator failures are handled safely with clear remediation:
- If a question has no correct answer, Gemini proposes and inserts a corrected answer candidate automatically (marked "auto-corrected by soma") for tutor review.
- If answer options are duplicated, Gemini rewrites duplicate distractors and marks the question as "auto-corrected."
- If explanation contradicts the answer, Gemini regenerates the explanation and tags the change.
- If level/topic/syllabus mismatch is detected, the question is flagged "needs review" and suggested replacement text is provided.
- If maths formatting is broken, soma attempts automatic rendering repair and surfaces before/after preview.
- Publish action remains enabled; unresolved issues are summarized in a pre-publish warning panel and in post-publish quality logs.

### 3.18 Destructive-Action Warnings

Confirmation modals with plain-language consequences for:
- Removing a student from the tutor list
- Removing a student from a group
- Deleting an assessment
- Leaving assessment creation with unsaved changes
- Exiting an assessment in progress

### 3.19 Draft Recovery (Assessment Creation)

Every in-progress assessment creation is auto-saved as a draft, capturing: title, subject, level, syllabus, selected topics, template type, Co-Pilot prompt, generated questions, Co-Pilot edit history, and time limit.

On return, surface: *"You have an unfinished assessment draft: Geometry Basics. Continue editing?"* with three actions: **Continue draft**, **Delete draft**, **Start new assessment**.

### 3.20 Terminology

Use **soma** (lowercase) consistently. Never "SOMA Tutor."

Canonical verbs: **Add Students** (not "Adopt Students"), **Create Assessment**, **Assign Assessment**, **Start Assessment**, **Review Answers**, **Submit Assessment**, **View Feedback**, **Download Report**, **Copy Summary**. AI surfaces are **soma feedback** and **soma suggestions**.

### 3.21 Explicitly Out of Scope (this release)

- Full onboarding flow
- Separate manual question editor
- Feedback timing controls (hide score, tutor-approval gates)
- In-app messaging / notes to students
- Email report, parent-share, CSV export, external integrations
- Class-first or school-first organisational model

### 3.22 Cost Estimate — Gemini Question Validation

Because validator cost is a concern, use Gemini as the default checker for per-question validation.

Assumptions for a planning estimate:
- Average generated quiz: 12 questions
- Validation calls: 1 call per question + 1 quiz-level call = 13 calls/quiz
- Average checker tokens/call (prompt + response): ~1,200 tokens
- Total checker tokens/quiz: ~15,600 tokens
- Monthly volume scenarios:
  - Low: 2,000 quizzes/month
  - Medium: 10,000 quizzes/month
  - High: 50,000 quizzes/month

Estimated monthly checker token volume:
- Low: 31.2M tokens/month
- Medium: 156M tokens/month
- High: 780M tokens/month

Budgeting model:
- Monthly checker cost ≈ `(input_tokens / 1M * input_rate) + (output_tokens / 1M * output_rate)`
- For planning, split total tokens as ~80% input and ~20% output unless measured data says otherwise.
- Use the current Gemini pricing page to plug exact rates at implementation time.

Cost controls:
- Skip re-check of unchanged questions after minor edits.
- Re-check only edited questions plus one final quiz-level pass.
- Cache checker results by question hash for repeated generation attempts.
- Run full strict validation only at publish time (lighter checks during drafting).

---

## 4. User Stories

### Tutor
- As a tutor, I want to add an individual student by name and email so I can assign them an assessment within a minute.
- As a tutor, I want to search my student list by name or email so I can pick the right student even when the list is long.
- As a tutor, I want to create an optional group (e.g. "AS Physics group") so I can assign the same assessment to several students at once, without being forced to use groups for one-off students.
- As a tutor, I want to remove a student from a group without deleting their account, so I can reshape my groups across terms.
- As a tutor, I want to create an assessment by picking subject, level, optional syllabus topics, and an optional Co-Pilot template, so generation is fast and on-target.
- As a tutor, I want to refine questions through natural-language instructions to soma ("make question 2 harder", "rewrite 1 in Cambridge IGCSE style") so I don't need a manual editor.
- As a tutor, I want soma to flag low-confidence or broken questions before I publish, so I don't assign bad work.
- As a tutor, I want a clear status for each student on each assignment (Assigned / Seen / Started / In progress / Submitted / Feedback ready / Overdue / Not opened), so I know who to follow up with.
- As a tutor, I want to see time-spent per question colour-coded, so I can spot struggle and careless rushing at a glance.
- As a tutor, I want to download a professional PDF report, so I can share results with a parent or keep a record.
- As a tutor, I want soma to automatically flag students needing intervention (low scores, repeated mistakes, overdue, sudden drop), so I can act on data not memory.
- As a tutor, I want my half-finished assessment drafts to be recoverable, so long Co-Pilot sessions aren't lost.

### Student
- As a student, I want the dashboard to show me what to do next — due now, upcoming, feedback ready — so I'm never unsure where to start.
- As a student, I want a short, calm assessment start screen, so I know what's coming without being overwhelmed.
- As a student, I want my answers to autosave as I go, so a dropped connection doesn't cost me progress.
- As a student, I want to resume an unfinished assessment exactly where I left off, so I don't have to start over.
- As a student, I want soma feedback immediately after I submit, so I can learn while the content is fresh.
- As a student, I want per-question explanations that tell me *why* I was wrong, not just the right answer.
- As a student, I want a radar graph of my syllabus coverage, so I can see my gaps at a glance.
- As a student, I want the quiz to work comfortably on my phone, so I can do homework on the bus.

### Admin
- As an admin, I want a clear **View as Tutor / View as Admin** toggle, so I never take an admin action by accident.
- As an admin, I want my elevated actions to be logged, so accountability is maintained.

### Super Admin
- As a super admin, I want to elevate a tutor to admin, so trusted users can help manage the platform.
- As a super admin, I want to see a full audit history of tutor activity, assessment creation, assignments, submissions, and report generation with timestamps, so I can investigate incidents.
- As a super admin, I want to see *who* created, edited, assigned, or deleted something, so every change is attributable.

---

## 5. Acceptance Criteria

### Student management (individual)
- **Given** a tutor has at least one student, **When** they open the Students page, **Then** the individual student list is the default view.
- **Given** the student list, **When** the tutor types into the search box, **Then** results filter by name **and** email in real time.
- **Given** a student row, **When** the tutor clicks **Remove**, **Then** a confirmation modal explains that the student's account and historical submissions are preserved.
- **Given** an individual student card, **Then** it displays name, email, level, subjects (if any), last active, assigned count, completed count, and a progress indicator.

### Optional groups
- **Given** a tutor with zero groups, **Then** the Students page is fully functional and does not prompt group creation.
- **Given** a tutor creates a group, **When** they add existing students, **Then** those students appear in the group view without losing their individual records.
- **Given** a tutor assigns an assessment to a group, **Then** each member receives the assignment individually and can be tracked individually.
- **Given** a tutor removes a student from a group, **Then** the student and their submissions persist outside the group.

### Assessment creation / Co-Pilot
- **Given** the creation flow, **When** subject and level are chosen, **Then** the optional syllabus, topics, and template fields become available.
- **Given** no template is selected, **Then** Co-Pilot still generates using subject, level, topics (if any), and free-text prompt.
- **Given** a generated assessment, **When** the tutor types "make question 2 harder", **Then** only question 2 is regenerated and a diff highlights the change before publishing.
- **Given** Co-Pilot generation, **When** Gemini checker finds a per-question issue (no correct answer, duplicated options, contradictory explanation, broken maths, or topic mismatch), **Then** soma auto-corrects what it can and shows question-level warnings/reasons.
- **Given** unresolved issues remain, **Then** publishing is still enabled, and the pre-publish panel clearly lists unresolved items for tutor decision.

### Topic selection
- **Given** subject and level are selected, **When** syllabus is selected, **Then** an optional topics dropdown appears in this order: Subject → Level → Syllabus → Topics.
- **Given** subject = Mathematics and level = IGCSE with Cambridge syllabus, **Then** the topics dropdown lists Algebra, Linear equations, Graphs, Geometry, Trigonometry, Mensuration, Probability, Statistics.
- **Given** no syllabus mapping exists, **Then** the topics dropdown is hidden or disabled with an explanatory message, and Co-Pilot still works.

### Student dashboard
- **Given** a student logs in, **Then** sections appear in order: Due now, Upcoming, Feedback ready, Recommended revision, Completed work.
- **Given** completed assessments with topic tags, **Then** a radar graph shows syllabus coverage by topic.

### Assessment-taking and autosave
- **Given** a student is mid-quiz, **When** they refresh, lose connection, or close the browser, **Then** re-entry restores current question, answers, flags, and elapsed time.
- **Given** an answer is saved, **Then** the save indicator reads "Saving…" then "Saved just now".
- **Given** a save fails, **Then** the student sees a red cloud-warning notification and autosave retries.

### Feedback and review
- **Given** a student submits, **Then** soma feedback is available immediately (no tutor gate).
- **Given** the review page, **Then** every question shows: question, student answer, correct answer, status, explanation of the correct method, explanation of why the chosen answer was wrong (when inferable), likely misconception, suggested next step.

### Assignment status and time
- **Given** an assignment, **Then** each student's status is exactly one of: Assigned, Seen, Started, In progress, Submitted, Feedback ready, Overdue, Not opened.
- **Given** the tutor review, **Then** time-per-question is colour-coded Green / Amber / Red / Grey per the rules in 3.11.

### Reports and exports
- **Given** a completed assessment, **When** the tutor clicks **Download PDF**, **Then** a structured PDF is generated including logo, student, tutor, title, subject, level, syllabus, topics, generation date, completion date, score, percentage, marks, total time, time-per-question, question-by-question breakdown, strengths, weaknesses, suggested revision, follow-up, syllabus coverage, radar graph.
- **Given** the tutor clicks **Copy summary**, **Then** clipboard contains a clean plain-text block matching the template in section 8.
- **Given** the report UI, **Then** only two export actions are visible: Download PDF, Copy summary.

### Maths rendering
- **Given** any surface containing maths, **Then** no raw `$…$`, `\( … \)`, broken fractions, escaped characters, or misplaced brackets are visible.
- **Given** a PDF is generated, **Then** maths in questions, explanations, and summaries renders identically to the in-app view.

### Destructive actions
- **Given** any destructive action (remove student, remove from group, delete assessment, leave with unsaved changes, exit assessment in progress), **Then** a confirmation modal describes the consequence in plain language before the action proceeds.

### Draft recovery
- **Given** a tutor abandons assessment creation, **When** they return, **Then** they see the draft-recovery prompt with Continue / Delete / Start new.

### Admin and audit
- **Given** an admin-elevated tutor, **Then** a persistent **View as Tutor / View as Admin** toggle is visible and the current mode is unambiguous.
- **Given** any admin-mode action, **Then** it is written to audit history with actor, action, target, and timestamp.
- **Given** the super admin audit view, **Then** it supports filtering by actor, action type, target, and date range.

---

## 6. UX Flow Recommendations

### 6.1 Tutor adds an individual student
1. Tutor → Students → **Add Students** (button top-right).
2. Modal: name, email, level, optional subjects.
3. Save → new student appears at the top of the individual list with a "new" indicator for 24 hours.
4. Inline **Assign Assessment** shortcut on the new row.

### 6.2 Tutor creates a group
1. Students → **Groups** tab (secondary tab, never the default).
2. **Create Group** → name (e.g. "IGCSE Maths group").
3. Add students via searchable picker (name + email shown).
4. Save → group appears; group card shows member count and aggregate progress.
5. From group card: **Assign Assessment**, **View Performance**, **Manage Members**.

### 6.3 Tutor creates an assessment using Co-Pilot
1. **Create Assessment** → title, subject, level.
2. Optional: syllabus → topics multi-select.
3. Optional: template type (Mixed revision / Diagnostic / Homework check / Exam-style mini paper).
4. Optional: free-text prompt.
5. **Generate with soma** → questions render with confidence indicators.
6. Tutor refines via natural language ("make 3 harder", "add an explanation for each").
7. Pre-publish Gemini check validates every question and the full quiz; auto-corrections are applied where possible, and unresolved issues are shown per question.
8. **Publish** → assessment is assignable.

### 6.4 Tutor selects subject, level, and topics
1. Subject (required) → Level (required).
2. If a syllabus mapping exists: Syllabus dropdown appears, defaulting to the most common option.
3. After syllabus selection, Topics dropdown (multi-select) appears, populated from that syllabus.
4. If no mapping: topics field hides with a note — "Generate from prompt instead."

### 6.5 Tutor assigns an assessment
1. From the assessment page, **Assign**.
2. Picker with two tabs: **Individuals** (default) and **Groups**.
3. Searchable list (name + email).
4. Set due date (optional) and time limit override (optional).
5. **Assign** → tutor sees confirmation with status board for this assignment.

### 6.6 Student receives notification
1. Dashboard shows blue/bell notification: "New assessment: Algebra Basics."
2. Clicking opens the assessment start screen.

### 6.7 Student starts assessment
1. Start screen shows title, subject, level, topics, Q count, marks, time limit, due date, short instructions, calculator rule.
2. **Start Assessment** → timer begins, autosave active.

### 6.8 Student resumes unfinished assessment
1. Dashboard shows purple/progress notification: "You have an unfinished assessment: Algebra Basics. Resume now."
2. Click → returns to the exact question, with preserved answers, flags, and elapsed time.

### 6.9 Student completes assessment
1. **Submit Assessment** → confirmation ("Submit now? You won't be able to change your answers.").
2. soma generates feedback immediately.
3. Student is routed to the feedback summary with a prompt to **Review Answers**.

### 6.10 Student reviews feedback
1. Summary: score, percentage, performance label, strengths, weaknesses, suggested revision, suggested follow-up, confidence indicator if low.
2. **Review Answers** → per-question page with explanations and misconception notes.
3. Radar graph updates to reflect new coverage.

### 6.11 Tutor reviews student report
1. Tutor dashboard → Assignment → student row.
2. Report shows score, time-per-question (colour-coded), per-question breakdown, strengths/weaknesses, soma suggestions.
3. Actions: **Download PDF**, **Copy Summary**, **Assign follow-up practice**, **Mark for offline discussion**, **Dismiss flag**.

### 6.12 Super admin promotes tutor to admin
1. Super admin → Users → Tutor profile → **Elevate to Admin** (with confirmation explaining consequences).
2. Tutor receives the **View as Tutor / View as Admin** toggle on next session.
3. All subsequent actions in Admin mode are audit-logged.

---

## 7. Prioritised Roadmap

### 7.1 Urgent Blockers (ship first — platform is not trustworthy without these)
1. **Searchable student selection with email displayed** in every student picker (assignment, group, review).
2. **Reliable Co-Pilot generation** — retries, graceful failure messages, never loses tutor input on a failed generation.
3. **Assessment draft recovery** — auto-save of in-progress creation with a recovery prompt on return.
4. **Assignment status tracking** — the eight statuses (Assigned → Feedback ready → Overdue) visible per student per assignment.
5. **Mobile assessment-taking** — quiz must be fully usable on a phone, including timer visibility and answer tap targets.
6. **PDF reports** — a real, structured, downloadable PDF (not a screenshot), including logo, identity, scores, per-question breakdown, date, and coverage.
7. **Autosave and resume** for in-progress student assessments.
8. **Robust maths rendering** across questions, options, explanations, review, PDF, and dashboard tips.
9. **Gemini per-question validity checker** with auto-correction plus unresolved-issue warnings (publish remains available).

### 7.2 High-Impact Improvements (next)
- Co-Pilot template options (Mixed revision / Diagnostic / Homework check / Exam-style mini paper).
- Topic selection from subject × level × syllabus, feeding generation, reports, and radar.
- Assignment-first student dashboard (Due now / Upcoming / Feedback ready / Recommended / Completed).
- Radar-style syllabus coverage graph on student dashboard and PDF.
- Colour-and-icon-coded notifications including due-date reminders and unfinished-assessment alerts.
- Improved per-question review (method explanation, why-wrong, likely misconception, next step).
- Diagnostic feedback summary (strengths / weak topics / careless vs conceptual / suggested revision / follow-up / confidence).
- Tutor intervention flags (low scores, struggle/rush times, overdue, drops, student-flagged questions).
- Time-per-question with colour coding in report, tutor review, PDF, and copy summary.
- Destructive-action confirmations (remove student, delete assessment, leave unsaved, exit in-progress).
- Consistent terminology ("soma", "Add Students", etc.).

### 7.3 Medium-Priority Improvements
- Optional groups (create, rename, add/remove members, group assignment, group performance view).
- AI content-check tools (check-for-errors, syllabus match, duplicate options, ambiguous wording).
- Pre-publish trust warnings (no correct answer, contradictory explanation, level mismatch, broken maths).
- Accessibility polish: focus rings, contrast, generous spacing between View and Remove, screen-reader labels.
- Copy summary export.
- Super admin audit history with filters.
- Admin role elevation with **View as Tutor / View as Admin** toggle.

### 7.4 Later Improvements
- Deeper analytics beyond the radar (trend lines, cohort comparisons).
- Additional syllabus coverage beyond the initial Cambridge / generic mappings.
- Group-level insight views (beyond basic aggregate).
- Richer Co-Pilot refinement UI (e.g. inline diff viewer).

### 7.5 Explicitly Deferred / Out of Scope
- Full onboarding flow.
- Separate manual question editor.
- Feedback timing controls.
- In-app messaging / notes to students.
- Email, parent-share, CSV, and external integrations.
- Class-first or school-first reorganisation.

---

## 8. Copy / Microcopy Suggestions

### Empty states
- Students (none): **"No students yet. Add a student so you can assign assessments and track progress."**
- Assessments (none): **"No assessments yet. Create your first assessment with soma, or start from a Co-Pilot template."**
- Student dashboard (no completed work): **"Once you complete your first assessment, your results and feedback will appear here."**
- Groups (none): **"No groups yet. Groups are optional — create one if you'd like to assign the same assessment to several students at once."**
- Notifications (none): **"You're all caught up."**
- Audit history (filtered, no results): **"No activity matches these filters. Try widening the date range."**

### Notifications
- New assessment: **"New assessment: {title}."**
- Due soon: **"{title} is due tomorrow."**
- Due today: **"{title} is due today."**
- Overdue: **"{title} is overdue."**
- Feedback ready: **"Feedback ready: {title}."**
- Unfinished: **"You have an unfinished assessment: {title}. Resume now."**
- Autosave issue: **"We couldn't save your last answer. Check your connection."**

### Confirmation modals
- Remove student: **"Remove {name} from your students? This will not delete the student account or previous submissions."**
- Remove from group: **"Remove {name} from {group}? They will remain in your student list."**
- Delete assessment: **"Delete this assessment? This cannot be undone. Existing student submissions may also be affected."**
- Leave creation unsaved: **"Leave assessment creation? Your draft will be saved and you can continue later."**
- Exit assessment in progress: **"Exit this assessment? Your answers are saved. You can resume from your dashboard."**
- Submit assessment: **"Submit now? You won't be able to change your answers after submitting."**
- Elevate to admin: **"Elevate {name} to admin? They'll gain admin tooling and a role toggle. All admin actions are logged."**

### Assessment start screen (template)
> **{Title}**
> {Subject} · {Level}{ · Topics: {topic list}}
> {N} questions · {Total marks} marks · {Time limit}
> {Due {date}}
> {Calculator allowed / Formula sheet provided — if applicable}
>
> Take your time and do your best.
>
> **[Start Assessment]**

### Feedback summary (templates)
- Strong: **"Excellent work. You showed a strong grasp of {topic A} and {topic B}. For your next step, try a mixed {subject} quiz with harder {specific skill} questions."**
- Average: **"You understood the basic method, but there were mistakes when {specific skill}. Revise {concept} and try a short follow-up quiz."**
- Weak: **"You struggled with the main method in this quiz. Start by revising how to {core skill} step by step, then try a simpler practice quiz."**

### Report download actions
- Button: **Download PDF** (primary) · **Copy Summary** (secondary).
- Post-copy toast: **"Summary copied to clipboard."**
- Post-download toast: **"Report downloaded."**

### Copy summary (example output)
> Bella Chen completed AS Chemistry – Bonding on 19 April 2026. Score: 70%. Strengths: ionic bonding and basic definitions. Needs revision: covalent structures and electron pair sharing. Suggested next step: short follow-up quiz on covalent bonding.

---

## 9. Risks and Edge Cases

| Scenario | Behaviour |
|---|---|
| Student loses internet mid-assessment | Local state is preserved; autosave retries in the background; on reconnect, server state is reconciled with local. Save indicator reflects reality truthfully. |
| Student refreshes or closes the browser | Re-entry restores current question, answers, flags, and elapsed time exactly. |
| Tutor selects the wrong student in the picker | Picker shows name **and** email to disambiguate; assignment step has a final confirmation listing the names. |
| Tutor duplicates an assignment to the same student | System detects an existing identical assignment and asks for confirmation before creating a duplicate. |
| Co-Pilot generates a bad question | Pre-publish Gemini checks auto-correct where possible (answer/explanation/duplicate options/formatting), flag unresolved issues, and keep publish available; tutor can regenerate a single question without losing the rest. |
| Co-Pilot generation times out or fails | Tutor input is preserved; clear error with **Retry** action; draft is auto-saved. |
| No topics exist for the chosen subject × level | Topics field hides with an explanatory note; Co-Pilot generates from subject, level, and prompt alone. |
| Admin switches role mode | The toggle is explicit and persistent; each mode switch is audit-logged; the current mode is shown prominently in the header. |
| PDF generation fails | Show an error toast with **Retry**, do not silently drop the click, and offer **Copy Summary** as a fallback. |
| Student tries to resubmit an already-completed assessment | The assessment is locked post-submission; student sees the feedback view instead of the quiz. |
| Student on a small phone screen | No horizontal scroll, no overlapping cards, timer stays visible without covering answers, tap targets ≥ 44pt, Submit is always reachable. |
| Maths fails to render in a specific surface | Pre-publish and pre-display validation catches raw `$…$` or `\( … \)`; report-generation unit tests cover PDF and copy-summary paths. |
| Tutor removes a student mid-assignment | Confirmation explains that past submissions remain; any active assignment is marked "student removed" in the tutor view rather than deleted. |
| Super admin loses audit filter context | Filters persist in the URL so they can be shared and restored. |
| Assessment with zero topic tags | Radar contributes at the subject × level axis only; coverage still updates for overall progress. |
| Two tutors share the same student email | The student picker distinguishes by the owning tutor context; system prevents cross-tutor leakage. |

---

## 10. Final Recommendation

To make soma feel reliable, professional, and classroom-ready, optimise relentlessly for **one tutor managing one student on a normal Tuesday evening**. That is the shape of almost every real session, and everything else — groups, admin tooling, analytics — should be built so that workflow stays frictionless.

Concretely, the release should be measured against four qualities:

1. **Never lose work.** Autosave, draft recovery, and reliable Co-Pilot retries are not optional polish — they are the foundation of trust. Ship these first.
2. **Always be clear about what's next.** The student dashboard, the assignment start screen, and the tutor's assignment status board should make the next action obvious without the user having to think. Every notification should earn its colour and icon.
3. **Be honest about AI.** Show confidence indicators, auto-correct obvious issues, clearly flag unresolved risks, and make it trivial for a tutor to ask soma to double-check its own output. Trust in AI-generated assessments is the single biggest risk to adoption, and visible checks are what convert sceptical tutors.
4. **Be professional on every surface.** Maths that renders correctly, a PDF that a parent would be proud to receive, consistent terminology ("soma", "Add Students", "Download Report"), and a quiz that works on a phone. These are the details that separate a classroom-ready product from a prototype.

Hold the scope line. Resist in-app messaging, feedback timing controls, CSV exports, and a full onboarding flow in this release — each of them is reasonable later, but including them now would dilute the improvements that actually move the needle. Keep individual students as the default, keep groups optional, keep feedback immediate, and keep question editing inside Co-Pilot. Soma becomes trustworthy when it does a small number of things exceptionally well.
