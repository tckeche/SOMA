import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyMock = vi.fn();
const getSomaUserByIdMock = vi.fn();

vi.mock("jsonwebtoken", () => ({
  default: {
    verify: verifyMock,
  },
}));

vi.mock("../server/storage", () => ({
  storage: {
    getSomaUserById: getSomaUserByIdMock,
  },
}));

describe("server auth helpers", () => {
  beforeEach(() => {
    verifyMock.mockReset();
    getSomaUserByIdMock.mockReset();
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.JWT_SECRET = "phase-2-test-secret";
  });

  it("parses cookies and reads the configured admin session token", async () => {
    const { getAdminSessionToken, parseCookies } = await import("../server/auth");
    const req = { headers: { cookie: "a=1; admin_session=test-token" } } as Request;
    expect(parseCookies(req)).toEqual({ a: "1", admin_session: "test-token" });
    expect(getAdminSessionToken(req, "admin_session")).toBe("test-token");
  });

  it("returns an authorized bearer user when the token and role are valid", async () => {
    verifyMock.mockReturnValue({ sub: "tutor-1", email: "tutor@example.com" });
    getSomaUserByIdMock.mockResolvedValue({
      id: "tutor-1",
      email: "tutor@example.com",
      role: "tutor",
      displayName: "Tutor One",
    });

    const { getAuthorizedUserFromBearer } = await import("../server/auth");
    await expect(getAuthorizedUserFromBearer("token", ["tutor", "super_admin"]))
      .resolves.toEqual({
        id: "tutor-1",
        email: "tutor@example.com",
        role: "tutor",
        displayName: "Tutor One",
      });
  });

  it("rejects bearer users whose roles are outside the allowed set", async () => {
    verifyMock.mockReturnValue({ sub: "student-1", email: "student@example.com" });
    getSomaUserByIdMock.mockResolvedValue({
      id: "student-1",
      email: "student@example.com",
      role: "student",
      displayName: "Student One",
    });

    const { getAuthorizedUserFromBearer } = await import("../server/auth");
    await expect(getAuthorizedUserFromBearer("token", ["tutor", "super_admin"]))
      .resolves.toBeNull();
  });
});
