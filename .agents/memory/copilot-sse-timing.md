---
name: Copilot SSE generation timing
description: Why the tutor quiz-generation request must not use a hard wall-clock client timeout.
---

The tutor Co-Pilot generation (`POST /api/tutor/copilot-chat`, streamed via SSE) runs a real multi-model Maker→Verifier→blind-solver pipeline (Claude Opus + GPT-5 high-reasoning + Gemini). End-to-end it legitimately takes **~2–4 minutes**, with a long *silent* gap during the GPT-5 verification stage (no SSE events emitted between "verifying" and "saving"/"done").

**Rule:** the client must bound this request by **inactivity**, not total wall-clock time. The server emits ~10s SSE heartbeat pings (`: ping`) and the client resets an idle watchdog on every received byte; only true silence (e.g. 90s) aborts.

**Why:** a previous hard 90s wall-clock `AbortController` timeout killed generations mid-verification. The backend finished and persisted questions, but the UI showed a false "Generation failed or produced no valid draft," and the draft never appeared. Found via Playwright e2e (gen completed server-side at ~153s, past the 90s wall).

**How to apply:** if you touch the copilot SSE client loop or the server stream, keep the heartbeat + idle-reset pair intact; don't reintroduce a single fixed timeout around the whole stream. Always exercise the gen path with patience (poll up to ~4 min) when e2e-testing.
