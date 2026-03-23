import { describe, expect, it } from "vitest";
import { createIdentityHeaders } from "@/lib/identityHeaders";

describe("createIdentityHeaders", () => {
  it("adds the requested identity header when a user id is provided", () => {
    expect(createIdentityHeaders("x-tutor-id", "user-123")).toEqual({
      "x-tutor-id": "user-123",
    });
  });

  it("merges extra headers without dropping them", () => {
    expect(
      createIdentityHeaders("x-admin-id", "admin-1", {
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      }),
    ).toEqual({
      "x-admin-id": "admin-1",
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
  });

  it("returns only extra headers when no user id is available", () => {
    expect(createIdentityHeaders("x-tutor-id", null, { Authorization: "Bearer token" })).toEqual({
      Authorization: "Bearer token",
    });
  });
});
