# SOMA Quiz Reliability — Fix Plan (tracker)

Branch: `claude/gracious-noether-s8jgpm`. Commit after each phase. Test: `npm test`.

| Phase | Scope | Status |
|------|-------|--------|
| 1 | C-1 undefined `sanitizeQuestionForPreSubmission`; C-2 review uses `effectiveCorrectAnswer`; C-6 grading gets sanitized answers | ☑ 38881f6 |
| 2 | Schema: `reviewStatus`, `generationMeta`, difficulty CHECK + migration | ☐ |
| 3 | C-5 safe `balanceAnswerOptions` (reorder rationales, handle dup/missing) + apply in main generate paths | ☐ |
| 4 | C-3 persist `optionRationales`, difficulty/topic/subtopic tags, per-question misconception ids in all save paths | ☐ |
| 5 | §7 `validateQuestionQuality` gate + C-4 publish gate (status draft until approved; never serve auto_blocked) | ☐ |
| 6 | L-2 enforce difficulty in `enforceAllocation` + post-gen drift check | ☐ |
| 7 | L-1/§9 independent blind-solver vote for non-math questions | ☐ |
| 8 | L-4 per-question attribution + better distractor match; L-5 re-enable stem drift guard; L-6 explanation gate all types; audit columns wired | ☐ |
| 9 | Tutor pre-publish review UI (approve/edit/reject; surface warnings + reviewStatus) | ☐ |
| 10 | Tests (§14) + full suite green | ☐ |

## Decisions
- C-2: keep `effectiveCorrectAnswer` at marking; make review endpoint use the SAME value (no migration, consistent everywhere). New questions also pass answer∈options via the Phase 5 gate.
- Quizzes become `status:"draft"` at generation; publish only after gate marks questions `approved`/auto-approved. `auto_blocked` questions are never served to students.

## Notes for future sessions
- Pipeline: `server/services/aiPipeline.ts` (runOnePassQuiz). Save paths: `server/routes.ts` ~3411 (AI publish, the only one that already persists rationales), ~3809 (copilot add), ~4424 (copilot audit), ~5466 (student generate), ~5610 (tutor generate).
- Marking: routes.ts ~5728 submit; review endpoint ~5889. Math: `server/services/mathValidator.ts`.
