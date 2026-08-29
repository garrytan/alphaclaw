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
    // Every entry has the meta the menu/modal need. Icons are shared icon
    // components (or null) — never /assets/* URLs, which the gateway proxy
    // shadows (ISSUE-004).
    for (const entry of kChannelRegistry) {
      expect(entry.id).toBeTruthy();
      expect(entry.label).toBeTruthy();
      expect(entry.icon === null || typeof entry.icon === "function").toBe(
        true,
      );
      expect(entry.iconSrc).toBeUndefined();
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

describe("frontend/buzz wizard resume mapping (5.2/5.3)", () => {
  it("resumes at the step the server state machine paused on", async () => {
    vi.resetModules();
    vi.doMock("preact/hooks", () => {
      const slots = [];
      let cursor = 0;
      const effects = [];
      return {
        useState: (v) => {
          const i = cursor++;
          if (!(i in slots)) slots[i] = typeof v === "function" ? v() : v;
          return [
            slots[i],
            (n) => {
              slots[i] = typeof n === "function" ? n(slots[i]) : n;
            },
          ];
        },
        useRef: (v = null) => {
          const i = cursor++;
          if (!(i in slots)) slots[i] = { current: v };
          return slots[i];
        },
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
        useEffect: (effect) => effects.push(effect),
        __run: async () => {
          for (const effect of effects.splice(0)) {
            try {
              await effect();
            } catch {}
          }
        },
        __reset: () => {
          cursor = 0;
          effects.length = 0;
        },
      };
    });
    vi.doMock("../../lib/public/js/lib/api.js", () => ({
      fetchBuzzSetup: vi.fn(async () => ({
        ok: true,
        state: {
          status: "awaiting-approval",
          relayUrl: "wss://relay.example",
          publicKey: "BZresumeKey",
          lastProbeAt: Date.parse("2026-08-28T00:00:00Z"),
          lastProbeDetail: "Waiting for a room owner to approve the bot.",
        },
      })),
      runBuzzSetupAction: vi.fn(),
    }));
    vi.doMock("../../lib/public/js/components/toast.js", () => ({
      showToast: vi.fn(),
    }));
    vi.doMock("../../lib/public/js/lib/clipboard.js", () => ({
      copyTextToClipboard: vi.fn(async () => true),
    }));

    const hooks = await import("preact/hooks");
    const { BuzzWizard } = await import(
      "../../lib/public/js/components/channels/buzz-wizard.js"
    );
    const props = { visible: true, onClose: () => {}, onFinished: () => {} };
    hooks.__reset();
    BuzzWizard(props); // collect the load effect
    await hooks.__run(); // fetchBuzzSetup resolves → step = awaiting-approval
    hooks.__reset();
    const vnode = BuzzWizard(props);
    // Template interpolation splits numbers into separate text nodes —
    // normalize whitespace before matching.
    const text = collectText(vnode).join(" ").replace(/\s+/g, " ");
    // Reload landed on the approval step — never back at "Before you start",
    // with the SAME identity (public key) and last-checked stamp.
    expect(text).toContain("Step 4 of 5");
    expect(text).toContain("BZresumeKey");
    expect(text).toContain("last checked");
    expect(text).not.toContain("Install the plugin. AlphaClaw runs");
    vi.doUnmock("preact/hooks");
    vi.doUnmock("../../lib/public/js/lib/api.js");
    vi.doUnmock("../../lib/public/js/components/toast.js");
    vi.doUnmock("../../lib/public/js/lib/clipboard.js");
    vi.resetModules();
  });
});
