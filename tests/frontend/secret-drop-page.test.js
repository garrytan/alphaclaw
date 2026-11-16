import { describe, expect, it } from "vitest";
import { describeUsability } from "../../lib/public/js/components/secret-drop/index.js";

describe("frontend/secret drop page", () => {
  it("says a .env copy is usable now and reaches the gateway at its next start", () => {
    const text = describeUsability({ stores: { env: true, store: true }, reach: { env: "next_gateway_start", storeKind: "secret" } });
    expect(text).toMatch(/^Usable now by programs that read \.env/);
    expect(text).toContain("after its next start");
  });

  it("says the gateway already uses it when OpenClaw reloaded its secrets", () => {
    expect(describeUsability({ stores: { env: true, store: true }, reach: { env: "gateway_env", reloaded: true } })).toMatch(/^Usable now: OpenClaw reloaded/);
  });

  it("names a key the gateway's environment never gets", () => {
    expect(describeUsability({ stores: { env: true, store: true }, reach: { env: "never" } })).toContain("never gets it");
  });

  it("covers a store-only save (a multi-line value)", () => {
    expect(describeUsability({ stores: { env: false, store: true }, reach: { env: null, storeKind: "secret" } })).toBe(
      "In OpenClaw's secret store now. The gateway uses it after its next start.",
    );
  });
});
