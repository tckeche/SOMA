---
name: Botched multi-branch merge recovery
description: How to diagnose/repair a codebase left broken by a bad multi-branch merge (cascade parse errors, missing symbols, lost definitions).
---

When several feature branches are merged together and the resolution is bad, the working tree can be git-clean yet the build is broken. Symptoms seen here: the dev server (tsx/esbuild) starts because esbuild skips cross-file type checks, but `tsc --noEmit` reports a couple of TS1005 parse errors at code that *looks* perfectly valid.

**The lesson / how to apply:**
1. A TS1005 ("',' expected" / "')' expected") reported at valid-looking code is almost always a *cascade* — the real fault is an unterminated construct earlier (an unclosed `(` / `{`, or a function declaration that got mangled into something else). Find and fix that first.
2. Fixing the parse error unblocks `tsc`'s semantic pass, which then surfaces a pile of previously-hidden "Cannot find name X" errors. These are usually dropped imports or definitions the merge lost.
3. Recover lost definitions verbatim with `git log -S "<symbolName>" --oneline -- <file>` to find the commit that introduced them, then `git show <commit>:<file>` to copy the original block back. Don't hand-reconstruct from memory.
4. When two parallel branches each add a similar helper (e.g. two `sendApiError` in different modules, or duplicate `declare module` augmentations of `Request`), reconcile by matching the **call-site signature** to pick the right import source, and delete the duplicate type augmentation.
5. Re-run `tsc --noEmit` to confirm exit 0, restart the workflow, and curl the affected endpoints (auth gates especially — a dropped `requireSupabaseAuth` turns a 401 into a 500).

**Why:** esbuild's lenient transpile masks merge breakage; only `tsc` + endpoint smoke tests reveal it. Treating the first parse error as the root cause wastes time — it's the symptom.
