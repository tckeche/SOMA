/**
 * TUTOR SIGNUP ROLE GATE (S1)
 *
 * A client-supplied requested_role must never, by itself, grant the tutor
 * role — otherwise anyone signing up could self-provision the entire tutor
 * API surface. New tutor accounts are only minted from a server-verified
 * signal: the TUTOR_EMAIL_DOMAIN (or the TUTOR_EMAIL_ALLOWLIST). Everyone else
 * defaults to student. super_admin is never self-selectable.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import supertest from "supertest";

vi.mock("../server/db", () => ({ db: null }));
vi.mock("express-rate-limit", () => ({
  default: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  rateLimit: vi.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  ipKeyGenerator: vi.fn().mockReturnValue("test-ip"),
}));

import { registerRoutes } from "../server/routes";

let request: supertest.SuperTest<supertest.Test>;
let seq = 0;
const freshId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  request = supertest(app);
});

describe("determineRole via /api/auth/sync", () => {
  it("does NOT grant tutor for a self-selected requested_role from a non-domain email", async () => {
    const res = await request
      .post("/api/auth/sync")
      .send({ id: freshId(), email: "randomperson@gmail.com", user_metadata: { requested_role: "tutor" } });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("student");
  });

  it("grants tutor for an email on the configured tutor domain", async () => {
    const res = await request
      .post("/api/auth/sync")
      .send({ id: freshId(), email: "teacher@melaniacalvin.com", user_metadata: { requested_role: "tutor" } });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("tutor");
  });

  it("never lets super_admin be self-selected", async () => {
    const res = await request
      .post("/api/auth/sync")
      .send({ id: freshId(), email: "wannabe-admin@gmail.com", user_metadata: { requested_role: "super_admin" } });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("student");
  });
});
