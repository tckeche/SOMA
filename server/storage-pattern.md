# Storage layer — modularisation pattern

`server/storage.ts` is a 2,000-line monolith holding the `IStorage`
interface plus `DatabaseStorage` and `MemoryStorage` implementations. We
are not moving its existing methods in Phase 1. Instead we are stopping
new growth.

## Where new query code goes

For any new domain in Phase 2 / 3 (examiner insights, mastery rollups,
revision plans, AI usage history, etc.) **do not** add methods to
`IStorage` / `DatabaseStorage` / `MemoryStorage`. Instead create a focused
module under `server/services/`:

```
server/services/<domain>Queries.ts   // read-side
server/services/<domain>Writes.ts    // write-side (when complex)
```

Each module owns its own Drizzle queries against the typed schema in
`shared/schema.ts`, returns plain DTOs, and is unit-testable in
isolation.

### Precedents already in the tree

- `server/services/aiUsageStore.ts` — fire-and-forget writes to
  `ai_usage_logs` from telemetry.
- `server/services/aiUsageQueries.ts` — historical reads + joins for the
  super-admin spend dashboard.

## When to migrate something out of `storage.ts`

Only when it's a natural fit — e.g. a Phase 2 feature touches a storage
method whose neighbours all relate to the same domain. Lift the cluster
out together. Otherwise leave it. Mechanical splits without behavioural
change risk subtle bugs and merge conflict pain.

## Why we still have `IStorage`

The `storage` proxy export in `storage.ts` lazily resolves to
`DatabaseStorage` (when `db` is configured) or `MemoryStorage` (tests /
local without DB). The proxy + interface contract is genuinely useful
for the legacy methods because tests rely on the in-memory fallback. New
query modules don't need this — they can short-circuit to `db` directly
and treat the absence of `db` as an empty-result no-op (see how
`aiUsageQueries.getHistoricalUsage` handles `db === null`).
