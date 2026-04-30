# SOMA 72-hour Audit Report (April 28–30, 2026)

## Scope and method

This audit validates recent changes against the product goal: reliable, explainable, curriculum-aligned assessment for school maths/science. Evidence sources:

- Git history from `2026-04-27` onward.
- Existing project tests and build/compile checks.
- Existing implementation notes in the repository state.

## Executive status

- **Deployment buildability:** ✅ Production build currently succeeds.
- **Runtime/test stability:** ⚠️ Test suite is mostly green but has **4 failing tests** (known baseline failures), so quality gate is not fully clean.
- **Type safety:** ❌ `tsc` fails with iterable-target errors in `mathValidator.ts`.
- **Core product intent preservation:** ⚠️ Largely preserved and improved (review queues, provenance, warnings), but curriculum-link coverage is still below target and misconception source quality is a major blocker.

## What is working well

### 1) Examiner Insights loop is materially implemented
- End-to-end workflow exists: extraction → review queue → approval gating → downstream use.
- Review UX includes confidence, orphan filtering, and bulk moderation, reducing ungoverned AI outputs.
- This strongly supports explainability and traceability.

### 2) Catalogue FK migration is structurally correct
- Core FK back-links were added and backfill logic exists.
- Phase-15 normalization and fuzzy fallback improved mapping quality.
- Additive migration pattern appears preserved (including `pg_trgm` extension migration).

### 3) AI reliability posture improved
- Hard caps/model policies/idempotency and fallback orchestration are present and broadly tested.
- Answer-key guardrails now emit structured warnings rather than silently coercing wrong answers.
- This directly reduces invisible failure modes.

## What is not working / risk areas

### 1) Hard quality-gate failures remain
From current local validation:

- `npm test` ends with **4 failing tests**:
  - `tests/tutorAssessmentDraft.test.ts` (3 failures): `selectedSubtopicIds` undefined path in `isMeaningfulDraft` causes runtime TypeError for older/partial draft shapes.
  - `tests/assessmentGeneration.test.ts` (1 failure): dark-theme enforcement expectation mismatch (`forcedTheme="dark"` not present).
- `npm run check` fails with TS2802 iterable-target errors in `server/services/mathValidator.ts`.

Impact:
- Risk of regressions in tutor draft handling (possible UI interruption).
- Build pipeline may pass while type-check gate fails, creating release inconsistency.

### 2) Curriculum-link coverage is still below target
- Question back-linking improved but remains below the stated target.
- Misconception matching remains critically low due to upstream extraction quality mismatch (topic hallucination against syllabus taxonomy).

Impact:
- Diagnostics and mastery analytics can be incomplete or misleading for non-math subjects.
- This threatens core promise of curriculum fidelity.

### 3) Visibility/control gaps still open
- Orphan sweep pagination is incomplete (first-page limitation).
- Queue filter persistence not implemented.
- Some legacy workflows/tables remain active/undeleted and can cause operator confusion.

Impact:
- Admins can miss unresolved items.
- Operational observability remains partial.

## Crash and invisibility analysis

### Potential crash points
- `isMeaningfulDraft` assumes arrays exist; malformed/legacy payloads can throw.
- Long-running row-by-row backfill scripts can terminate under restarts.

### “Can something happen without me seeing it?”
- Improved vs baseline: approval gating + warnings + queue confidence greatly increase visibility.
- Remaining blind spots:
  - Low-quality misconception extraction can still enter queue at scale.
  - Partial pagination can hide unresolved orphans.
  - Build success without clean type-check/test can mask release risk.

## Database/schema assessment

### Positives
- Migration style is additive and cautious.
- FK expansion aligns with intended taxonomy graph.
- `pg_trgm` extension migration supports deterministic fuzzy recovery.

### Gaps
- Data quality in source misconception rows is primary bottleneck, not schema.
- Legacy bridge tables/processes still present; deprecation not fully completed.
- Need stronger DB-level or service-level validation to reject impossible topic/syllabus combos earlier.

## Prioritized actions (recommended)

### P0 (must do before claiming “fully stable”)
1. Fix `isMeaningfulDraft` defensive defaults for `selectedSubtopicIds` (and similar optional arrays).
2. Resolve dark-theme contract mismatch (align code or test contract intentionally).
3. Fix `tsc` iterable-target issue in `mathValidator.ts` or tsconfig target/downlevel settings.
4. Enforce CI gate requiring build + type-check + tests all green for release tags.

### P1 (high value next)
5. Implement task #25 normalizer for noisy question tags.
6. Implement task #26 re-extraction with closed catalogue allow-list per syllabus.
7. Add server-side pagination + persistent filters for orphan/review queues.

### P2 (operational hardening)
8. Disable unintended auto-start on legacy ingest workflow.
9. Continue route modularization to reduce monolith risk in `server/routes.ts`.
10. Improve commit hygiene (replace opaque “I don’t know” commit messages).

## Conclusion

The app is **not yet in a “everything in order / no crash risk” state**. It has strong progress in governance and explainability, and production build succeeds, but current evidence shows unresolved type-check and test failures plus data-quality gaps in misconception ingestion.

The core mission (curriculum-aligned, explainable assessment) is directionally preserved, but to preserve it **fully** you need to close P0 items and execute #25/#26 so catalogue alignment is trustworthy across subjects.
