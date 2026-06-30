---
name: PDF dual-AI marking rollout state
description: Why PDF dual-AI marking must stay disabled in production, and the deployment constraint its worker imposes.
---

# PDF dual-AI marking — keep disabled until the adapter exists

The PDF dual-AI marking surface (schema, durable PG job queue, state machines,
tutor-approval routes/UI) is a **foundation only**. The actual marking is a
**fail-closed stub**: the worker's `mark()` hard-codes `aiMarkingStatus =
"failed_terminal"` ("Production provider adapter failed closed"), and `prepare()`
only writes a placeholder rubric. The vision provider adapter is a ~7-line stub.

**Decision:** keep it OFF in production (`PDF_DUAL_MARKING_ENABLED=false`,
`PDF_MARKING_WORKER_ENABLED=false`, both set explicitly in the shared env scope;
code also defaults both to false). Manual marking is the active path and the
rollback path.

**Why:** enabling it without a real adapter is *worse* than manual mode — every
`dual_ai` student submission would terminate in `failed_terminal` instead of
getting a tutor mark.

**How to apply:** do not flip these flags on until (1) `pdfVisionProvider.ts` +
reconciliation are actually implemented with two independent multimodal
providers, and (2) the worker has somewhere to run (see constraint below).

## Deployment constraint: in-process pollers need vm, not autoscale

The marking worker is an **in-process `setTimeout` poller** started inside the
Express server. The live deployment is **autoscale**, which scales to zero and
spins up per request — a background poller will not run reliably there, so jobs
would queue in Postgres and never get leased. Running the worker requires a
**`vm` (reserved VM)** deployment, or splitting it into a **`scheduled`**
deployment. This applies to any in-process background loop added to this app.

## Bootstrap script note

`npm run db:bootstrap` and `npm run db:verify-live` are the **same script**
(`script/applyBootstrapMigrations.ts`): connect → `applyBootstrapMigrations`
(idempotent) → `verifySchemaMatchesDb` → non-zero exit on drift. There is no
verify-only mode; running both is just an idempotent re-apply.
