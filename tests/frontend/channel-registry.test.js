import { describe, expect, it } from "vitest";
import {
  kChannelRegistry,
  kAllChannelIds,
  getChannelRegistryEntry,
} from "../../lib/public/js/lib/channel-registry.js";
import { BuzzPendingCard } from "../../lib/public/js/components/channels/buzz-wizard.js";

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (typeof node.type === "function") {
      try {
        collectText(node.type(node.props || {}), out);
      } catch {}
    }
    collectText(node.props?.children, out);
  }
  return out;
};

describe("frontend/channel-registry (5.0)", () => {
  it("carries every provider exactly once with the flags the UI keys on", () => {
    expect(kAllChannelIds).toEqual([
      "telegram",
      "discord",
      "slack",
      "whatsapp",
      "clickclack",
      "buzz",
    ]);
    expect(new Set(kAllChannelIds).size).toBe(kAllChannelIds.length);
    expect(getChannelRegistryEntry("clickclack")).toEqual(
      expect.objectContaining({
        envKey: "CLICKCLACK_BOT_TOKEN",
        guidedSetup: true,
      }),
    );
    expect(getChannelRegistryEntry("buzz")).toEqual(
      expect.objectContaining({ wizard: true, capability: "buzzChannel" }),
    );
    expect(getChannelRegistryEntry("nope")).toBeNull();
    // Every entry has the meta the menu/modal need.
    for (const entry of kChannelRegistry) {
      expect(entry.id).toBeTruthy();
      expect(entry.label).toBeTruthy();
      expect(typeof entry.iconSrc).toBe("string");
    }
  });
});

describe("frontend/buzz pending card (5.2/D15)", () => {
  it("renders only while awaiting approval, naming what stays installed", () => {
    expect(BuzzPendingCard({ state: null })).toBeNull();
    expect(BuzzPendingCard({ state: { status: "idle" } })).toBeNull();
    expect(BuzzPendingCard({ state: { status: "done" } })).toBeNull();

    const text = collectText(
      BuzzPendingCard({
        state: {
          status: "awaiting-approval",
          publicKey: "BZpubKEY123",
          lastProbeAt: Date.parse("2026-08-28T00:00:00Z"),
        },
      }),
    ).join(" ");
    expect(text).toContain("Waiting for Buzz approval");
    expect(text).toContain("BZpubKEY123");
    expect(text).toContain("stay installed");
    expect(text).toContain("last checked");
  });
});
