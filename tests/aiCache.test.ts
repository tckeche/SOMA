/**
 * Tests for the AI response cache.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as cache from "../server/services/aiCache";

beforeEach(() => {
  cache._resetCacheForTests();
});

describe("aiCache: buildCacheKey", () => {
  it("is deterministic for identical inputs", () => {
    const a = cache.buildCacheKey({ inputHash: "abc", promptVersion: "v1", model: "gpt-4o" });
    const b = cache.buildCacheKey({ inputHash: "abc", promptVersion: "v1", model: "gpt-4o" });
    expect(a).toBe(b);
  });

  it("changes when prompt version changes", () => {
    const a = cache.buildCacheKey({ inputHash: "abc", promptVersion: "v1", model: "gpt-4o" });
    const b = cache.buildCacheKey({ inputHash: "abc", promptVersion: "v2", model: "gpt-4o" });
    expect(a).not.toBe(b);
  });
});

describe("aiCache: get/set + TTL", () => {
  it("returns set values within TTL", () => {
    cache.set("k1", { hello: "world" }, 1000);
    expect(cache.get<{ hello: string }>("k1")).toEqual({ hello: "world" });
  });

  it("expires values after TTL", async () => {
    cache.set("k2", "v", 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.get("k2")).toBeUndefined();
  });
});

describe("aiCache: memoize", () => {
  it("computes once on miss, returns cached on hit", async () => {
    let calls = 0;
    const compute = async () => { calls++; return "computed"; };
    const first = await cache.memoize("k3", 1000, compute);
    const second = await cache.memoize("k3", 1000, compute);
    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(calls).toBe(1);
    expect(second.value).toBe("computed");
  });

  it("does not cache when compute throws", async () => {
    let attempts = 0;
    const compute = async () => { attempts++; throw new Error("boom"); };
    await expect(cache.memoize("k4", 1000, compute)).rejects.toThrow("boom");
    await expect(cache.memoize("k4", 1000, compute)).rejects.toThrow("boom");
    expect(attempts).toBe(2);
  });
});
