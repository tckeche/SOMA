---
name: Background processes & /tmp persistence
description: Why backgrounded long-running commands and /tmp output files keep disappearing in this repl, and the reliable pattern to type-check.
---

Backgrounded shell jobs (`cmd &`, `nohup`, even `setsid`) get terminated shortly after
the originating tool call returns, and again whenever a deploy/checkpoint event fires.
Output files written to `/tmp` (and even `.local/tmp`) also disappear between tool calls.

**Why:** the sandbox tears down the tool call's process group and periodically clears
temp dirs; deploy/"Published your App" events restart the workflow and wipe scratch state.

**How to apply:** to type-check the project, run tsc *synchronously* inside one tool call
with a guard under the 120s tool cap, e.g. `timeout 115 npx tsc --noEmit 2>&1 | head -40; echo "EXIT:${PIPESTATUS[0]}"`.
The full project tsc completes within ~115s here (EXIT:0 = clean). Do not rely on
polling a background log file — it will be empty or missing.
