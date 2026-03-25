# Codebase Audit — Math-Quiz-Hub (2026-03-25)

## Scope
Full-stack review focused on reliability, security, graph correctness, scalability, and release-readiness.

## Highest-risk findings

1. **Broken authorization model on multiple endpoints (critical).**
   - `/api/auth/sync`, `/api/auth/me`, `/api/soma/quizzes/:id/submit`, `/api/soma/quizzes/:id/check-submission`, `/api/soma/reports/:reportId/retry`, `/api/soma/global-tutor` rely on caller-provided IDs or are unauthenticated.
   - Impact: account takeover-by-API, report tampering, privacy leaks, forced grading jobs, forged submissions.

2. **Header-based role fallback allows identity spoofing if bearer missing (critical/high).**
   - `createRoleMiddleware` accepts `x-tutor-id` / `x-admin-id` without cryptographic proof.
   - Impact: privilege escalation in misconfigured clients/proxies.

3. **Dynamic equation evaluation via `new Function` in graph renderer (high).**
   - Arbitrary expression evaluation from stored graph spec is unsafe and brittle.
   - Impact: XSS-like abuse paths, runtime instability, non-deterministic behavior.

4. **Graph math fidelity gaps for A-Level expectations (high).**
   - Discontinuity detection is heuristic and may connect or break curves incorrectly.
   - Domain constraints for log/sqrt/reciprocal not explicitly handled.
   - No native implicit/circle graphing.

5. **Logging leaks sensitive API payloads (medium/high).**
   - Global logger serializes full JSON responses for all `/api` routes.

## Immediate fix candidates

- Enforce Supabase auth for all student-specific routes.
- Remove unauthenticated ID-based route params/query patterns.
- Remove header identity fallback or restrict to trusted internal network only.
- Replace `new Function` parser with vetted math expression parser.
- Add graph segmentation and asymptote-aware plotting.
- Stop logging full JSON bodies for sensitive endpoints.

