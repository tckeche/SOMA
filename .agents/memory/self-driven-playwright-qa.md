---
name: Self-driven authenticated Playwright QA for SOMA
description: How to crawl SOMA as a real logged-in user without the testing subagent
---

To screenshot/crawl SOMA pages as an authenticated user (student/tutor/super_admin) from a node script:

- Launch Playwright with `executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE`. `npx playwright install` is a no-op in this environment.
- Mint a session WITHOUT a password: use supabase-js admin client (`SUPABASE_SERVICE_ROLE_KEY`) `auth.admin.generateLink({ type:'magiclink', email })`, then a normal anon client `auth.verifyOtp({ email, token: data.properties.email_otp, type:'email' })`. Pass a custom in-memory `storage` to the anon client so you can capture the exact localStorage entries Supabase writes, then inject them with `page.addInitScript` before navigating.
- App runs at `http://localhost:5000`.

**Gotcha:** dashboards take ~10s to populate (heavy queries). Screenshots taken too early look blank/skeleton — wait ~14s before capturing or you'll wrongly conclude a page is "broken/empty".

Keep all such testing strictly read-only — the Supabase DB holds real production data.
