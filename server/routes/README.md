# server/routes/

Per-domain Express route modules. Each file exports a single
`registerXyzRoutes(app: Express)` function that registers handlers under
a coherent URL prefix.

## Why this folder exists

`server/routes.ts` grew to 5,167 lines. Phase 1 of the SOMA roadmap stops
new growth there: every new endpoint added in Phase 2 and beyond should
land in a focused file under this folder, not in the legacy monolith.

## Conventions

- One file per domain (e.g. `superAdminAiUsage.ts`, `examinerInsights.ts`,
  `revisionPlans.ts`). Aim for &lt; 400 lines per file.
- Export a `registerDomainRoutes(app)` function. Domain registration is
  called by `server/routes/index.ts → registerDomainRoutes(app)`.
- Use the shared middleware from `server/middleware/roles.ts`
  (`requireTutor`, `requireSuperAdmin`, `requireSupabaseAuth`). Do **not**
  re-create role middleware inside a domain file.
- Use the modular query services from `server/services/*Queries.ts` for
  reads that don't fit cleanly on the legacy `storage` interface
  (precedent: `aiUsageQueries.ts`).
- Validate request bodies with Zod schemas defined alongside the route or
  in `shared/schema.ts` for things that touch the database.
- No business logic in route handlers. Push it down into a service.

## Migration plan

The legacy `server/routes.ts` continues to register everything it does
today via `registerRoutes(httpServer, app)`. Domain extractions happen
incrementally — typically when a Phase 2/3 feature lands and it's natural
to peel a related cluster out at the same time.

Adding a new domain file is a 3-step change:
1. Create `server/routes/&lt;domain&gt;.ts` exporting
   `registerXyzRoutes(app)`.
2. Wire it up in `server/routes/index.ts → registerDomainRoutes(app)`.
3. If you are *moving* an existing route, delete it from
   `server/routes.ts` in the same commit.
