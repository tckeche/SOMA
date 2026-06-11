/**
 * Students were showing up as their email prefix ("tckeche") in tutor-facing
 * lists because legacy sync fallbacks stored email.split("@")[0] as the
 * display name. formatPersonName must prefer a real name and otherwise
 * present a humanized version of the email prefix.
 */
import { describe, expect, it } from "vitest";
import { formatPersonName } from "../client/src/lib/personName";

describe("formatPersonName", () => {
  it("returns a real display name untouched", () => {
    expect(formatPersonName({ displayName: "Thandi Khumalo", email: "tk@example.com" })).toBe("Thandi Khumalo");
  });

  it("humanizes an email-prefix display name (legacy fallback rows)", () => {
    expect(formatPersonName({ displayName: "john.smith42", email: "john.smith42@gmail.com" })).toBe("John Smith");
    expect(formatPersonName({ displayName: "tckeche", email: "tckeche@gmail.com" })).toBe("Tckeche");
  });

  it("humanizes when the display name is the full email", () => {
    expect(formatPersonName({ displayName: "mary_jones@school.org", email: "mary_jones@school.org" })).toBe("Mary Jones");
  });

  it("derives a name from the email when display name is missing", () => {
    expect(formatPersonName({ displayName: null, email: "sipho-ndlovu@school.org" })).toBe("Sipho Ndlovu");
    expect(formatPersonName({ displayName: "", email: "a.b@x.com" })).toBe("A B");
  });

  it("falls back to the default label when nothing is available", () => {
    expect(formatPersonName({ displayName: null, email: null })).toBe("Student");
    expect(formatPersonName({ displayName: null, email: "12345@x.com" })).toBe("Student");
    expect(formatPersonName({}, "Tutor")).toBe("Tutor");
  });

  it("keeps a real name even if it shares words with the email", () => {
    expect(formatPersonName({ displayName: "John Smith", email: "john.smith@x.com" })).toBe("John Smith");
  });
});
