import crypto from "node:crypto";

export function canonicalEmail(email: string): string { return email.trim().toLowerCase(); }
export function hashCode(code: string, salt: string): string { return crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex"); }
export function make7DigitCode(): string { return `${crypto.randomInt(1000000, 10000000)}`; }
