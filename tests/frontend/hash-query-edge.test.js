import { describe, expect, it } from "vitest";
import { readHashQueryParam } from "../../lib/public/js/lib/hash-query.js";

describe("frontend/hash-query edge inputs", () => {
  it("returns empty for a missing or empty key", () => {
    expect(readHashQueryParam("#/doctor?focus=context", "")).toBe("");
    expect(readHashQueryParam("#/doctor?focus=context", null)).toBe("");
  });

  it("returns empty for null/undefined/queryless hashes", () => {
    expect(readHashQueryParam(null, "focus")).toBe("");
    expect(readHashQueryParam(undefined, "focus")).toBe("");
    expect(readHashQueryParam("#/doctor", "focus")).toBe("");
  });

  it("decodes URL-encoded values and treats a value-less param as absent", () => {
    expect(readHashQueryParam("#/doctor?a=1&focus=x%20y", "focus")).toBe("x y");
    expect(readHashQueryParam("#/doctor?focus", "focus")).toBe("");
    expect(readHashQueryParam("#/doctor?", "focus")).toBe("");
  });
});
