# PDF dual AI marking

SOMA extends the existing PDF Submission workflow with `pdf_marking_mode = manual | dual_ai`. Manual remains the default. In dual-AI mode, the same student upload endpoint stores a versioned PDF response and queues durable PostgreSQL jobs; students never see proposed scores or raw model output.

## Architecture and state machines
- Setup: `not_started → queued → processing → needs_review → ready` or `failed`.
- Submission: `queued/processing → needs_tutor_review|ready_for_approval → approved`, with `blocked_setup`, `failed_retryable`, `failed_terminal`, `superseded`, and `manual_override` fail-closed states.
- Jobs are stored in `pdf_marking_jobs` and leased with `FOR UPDATE SKIP LOCKED`.

## Provider independence
`PDF_MARKER_A_PROVIDER/MODEL` and `PDF_MARKER_B_PROVIDER/MODEL` must be configured. Same-provider marking is rejected unless `PDF_MARKING_ALLOW_SAME_PROVIDER=true`.

## Reconciliation rules
`server/services/pdfReconciliation.ts` accepts an item only when both blind markers award the same marks, both provide valid evidence, neither is uncertain/unreadable, and both verifiers accept the opposite decision. Disagreements create tutor review items. Totals are recomputed in TypeScript.

## Annotation format
Coordinates are integer basis points from 0 to 10,000. `server/services/pdfAnnotationRenderer.ts` renders ticks, crosses, omissions (`^^^`), uncertainty markers, and concise callouts onto a copy of the original PDF.

## Security model
Mark schemes live in `pdf_marking_documents`, not student-visible attachments. Storage paths, raw provider responses, prompts, and provider diagnostics are not returned to student DTOs. System prompts treat PDF content as evidence, never instructions.

## Environment variables
See `.env.example` for `PDF_DUAL_MARKING_ENABLED`, `PDF_MARKING_ADAPTER_ENABLED`, marker providers/models, worker runtime, attempt/page/timeout limits, and tutor-approval requirements. Keep both `PDF_DUAL_MARKING_ENABLED=false` and `PDF_MARKING_ADAPTER_ENABLED=false` in production until the adapter is ready.

## Known limitations
Dual-AI marking must remain disabled in production until the real multimodal adapter is implemented and `PDF_MARKING_ADAPTER_ENABLED=true` is deliberately set. Autoscale deployments must not run the in-process worker; use a VM or external scheduled worker. Tutor approval is always required in this release.
