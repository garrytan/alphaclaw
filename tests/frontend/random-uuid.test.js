import { describe, expect, it } from "vitest";
import { randomUuid } from "../../lib/public/js/lib/random-uuid.js";

const kUuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomUuid", () => {
  it("uses crypto.randomUUID in a secure context", () => {
    expect(randomUuid({ randomUUID: () => "from-random-uuid" })).toBe("from-random-uuid");
  });

  it("builds a v4 UUID from getRandomValues on plain HTTP (no randomUUID)", () => {
    const insecure = { getRandomValues: (array) => globalThis.crypto.getRandomValues(array) };
    const ids = new Set(Array.from({ length: 50 }, () => randomUuid(insecure)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(kUuidV4);
  });
});
