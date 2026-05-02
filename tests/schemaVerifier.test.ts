/**
 * Unit tests for the startup schema-drift detector.
 *
 * The verifier is the safety net that turns "I forgot to update
 * BOOTSTRAP_QUERIES" from a production 500 into a noisy startup error.
 * These tests pin down its three guarantees:
 *
 *  1. It actually walks `shared/schema.ts` and finds the tables we know
 *     are there.
 *  2. When the live DB is missing a table the schema declares, the report
 *     names that table.
 *  3. When the live DB has the table but is missing one of its declared
 *     columns, the report names that (table, column) pair.
 *
 * The pure `diffDeclaredAgainstLive` helper means we don't need a real
 * Postgres for these checks.
 */
import { describe, it, expect } from "vitest";
import {
  collectDeclaredTables,
  diffDeclaredAgainstLive,
  formatDriftReport,
  hasDrift,
} from "../server/schemaVerifier";

describe("collectDeclaredTables", () => {
  const tables = collectDeclaredTables();
  const names = new Set(tables.map((t) => t.name));

  it("finds every pgTable export from shared/schema.ts", () => {
    // Spot-check: the production outage that motivated this task involved
    // `soma_questions.option_rationales`, so make sure we're at least
    // looking at that table.
    expect(names.has("soma_questions")).toBe(true);
    expect(names.has("soma_users")).toBe(true);
    expect(names.has("soma_quizzes")).toBe(true);
    expect(tables.length).toBeGreaterThan(20);
  });

  it("includes the column that triggered the original outage", () => {
    const somaQuestions = tables.find((t) => t.name === "soma_questions");
    expect(somaQuestions).toBeDefined();
    expect(somaQuestions!.columns).toContain("option_rationales");
  });
});

describe("diffDeclaredAgainstLive", () => {
  const declared = [
    { name: "users", columns: ["id", "email", "role"] },
    { name: "posts", columns: ["id", "title", "body"] },
  ];

  it("returns no drift when every declared column is present", () => {
    const live = [
      { table_name: "users", column_name: "id" },
      { table_name: "users", column_name: "email" },
      { table_name: "users", column_name: "role" },
      { table_name: "posts", column_name: "id" },
      { table_name: "posts", column_name: "title" },
      { table_name: "posts", column_name: "body" },
    ];
    const report = diffDeclaredAgainstLive(declared, live);
    expect(report.missingTables).toEqual([]);
    expect(report.missingColumns).toEqual([]);
    expect(hasDrift(report)).toBe(false);
  });

  it("flags entirely missing tables", () => {
    const live = [
      { table_name: "users", column_name: "id" },
      { table_name: "users", column_name: "email" },
      { table_name: "users", column_name: "role" },
      // posts table is entirely absent
    ];
    const report = diffDeclaredAgainstLive(declared, live);
    expect(report.missingTables).toEqual(["posts"]);
    // Missing columns should NOT also include posts.* — we only report
    // the table once.
    expect(report.missingColumns).toEqual([]);
    expect(hasDrift(report)).toBe(true);
  });

  it("flags missing columns on existing tables", () => {
    const live = [
      { table_name: "users", column_name: "id" },
      { table_name: "users", column_name: "email" },
      // users.role missing
      { table_name: "posts", column_name: "id" },
      { table_name: "posts", column_name: "title" },
      { table_name: "posts", column_name: "body" },
    ];
    const report = diffDeclaredAgainstLive(declared, live);
    expect(report.missingTables).toEqual([]);
    expect(report.missingColumns).toEqual([
      { table: "users", column: "role" },
    ]);
    expect(hasDrift(report)).toBe(true);
  });

  it("ignores extra columns/tables in the live DB", () => {
    // Live DB has a legacy column and a legacy table the schema doesn't
    // declare. That's fine — we're only checking one direction.
    const live = [
      { table_name: "users", column_name: "id" },
      { table_name: "users", column_name: "email" },
      { table_name: "users", column_name: "role" },
      { table_name: "users", column_name: "legacy_token" },
      { table_name: "posts", column_name: "id" },
      { table_name: "posts", column_name: "title" },
      { table_name: "posts", column_name: "body" },
      { table_name: "old_audit_log", column_name: "id" },
    ];
    const report = diffDeclaredAgainstLive(declared, live);
    expect(report.missingTables).toEqual([]);
    expect(report.missingColumns).toEqual([]);
  });

  it("formatDriftReport renders both kinds of drift", () => {
    const report = {
      missingTables: ["posts"],
      missingColumns: [{ table: "users", column: "role" }],
    };
    const text = formatDriftReport(report);
    expect(text).toContain("missing table: posts");
    expect(text).toContain("missing column: users.role");
  });
});
