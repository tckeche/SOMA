# SOMA — Memory Index

- [Dev DB is Supabase](supabase-is-the-dev-db.md) — real data lives in Supabase; built-in execute_sql/Replit Postgres is empty and misleading.
- [Self-driven Playwright QA](self-driven-playwright-qa.md) — mint sessions via Supabase admin magiclink+verifyOtp; dashboards need ~14s to populate before screenshots.
- [Level color theme bridge](level-color-theme-bridge.md) — palette classes from getLevelColor/getSubjectColor need matching html.light overrides in index.css or light mode breaks.
- [Dashboard N+1 + cross-region DB](dashboard-stats-n1-perf.md) — Supabase pooler is in eu-central-1; per-id await-loops in storage cost seconds. Batch with inArray + Promise.all, bucket in memory.
