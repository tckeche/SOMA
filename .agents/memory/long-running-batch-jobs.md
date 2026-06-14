---
name: Long-running batch jobs in this environment
description: How to run multi-minute/hour batch scripts (e.g. LLM re-extraction) reliably; why nohup fails and how interrupted per-doc jobs orphan rows.
---

# Running long batch jobs (LLM re-extraction, embeddings, etc.)

**Never** run a long job via `nohup ... &` (or any `&` backgrounding) inside the bash
tool. The backgrounded process is killed when the bash tool call returns. A `pgrep`
right after can give a false positive because it matches its own command line, so it
*looks* alive but is dead.

**Do** run it as a Replit workflow (configureWorkflow with `outputType: "console"`,
`autoStart: true`). Workflows persist across tool calls.

**Why:** learned the hard way — first attempt with nohup silently died; the workflow
approach completed the whole Group-A examiner-misconception re-extraction.

## Workflows auto-restart — the script MUST be resumable
A console workflow can auto-restart unpredictably (observed several times mid-run).
That is only safe if the batch script is **resumable**: it must skip already-done
units. The misconception extractor uses `source_quote IS NOT NULL` per document as
the "done" sentinel and skips those on restart, so restarts lose no progress.

## Interrupted per-doc wipe-then-reinsert orphans one doc
The extractor deletes a document's old rows, then re-inserts. If a restart (or a
manual `removeWorkflow`) lands *between* the wipe and the re-insert, that one
in-flight document ends up with **zero** rows — it is not "legacy" (legacy counts
rows, and it has none), so aggregate legacy counts won't reveal it.

**Always** finish a re-extraction with an orphan check: find scoped docs that have
**no** misconception rows, then re-run the script scoped to that syllabus code — the
resumable-skip will process only the empty doc(s). Confirm zero orphans before
declaring done.

## How to observe progress
The script does NOT write to `ai_usage_logs` (that's app-only). The only reliable
progress signal is DB row counts against the real Supabase DB (see the diagnostics
note about querying it with a root-level `pg` script). Per-doc lines also appear in
the workflow console log (`[N/total] ... inserted= taxonomyDrops= closedSet=`).
