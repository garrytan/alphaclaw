import { describe, expect, it } from "vitest";
import {
  canAddSigningKey,
  canSaveSenderPreset,
  findPreset,
  formatIngressCounts,
  getIngressCacheKey,
  getSenderVerificationStatus,
  kSenderVerificationPresets,
  resolvePresetOptions,
  toCachedIngress,
} from "../../lib/public/js/components/webhooks/webhook-detail/sender-verification.js";

const makeIngress = (overrides = {}) => ({
  preset: "token",
  hasSecret: false,
  state: "token",
  firstAdmittedAt: null,
  closesAt: null,
  closedAt: null,
  sharedTokenAccepted: true,
  signedUrl: "https://box.example/hooks/notes",
  counts: { signed: 0, shared_token: 0, per_hook_token: 0, rejected: 0 },
  alert: null,
  readsRequestFields: false,
  presets: [],
  ...overrides,
});

describe("frontend/webhook sender verification status line", () => {
  it.each([
    ["token", "Uses the shared webhook token", "muted"],
    ["waiting", "Waiting for the first signed delivery. The shared token still works until then.", "warn"],
    ["closed", "Closed: only signed deliveries are accepted.", "ok"],
  ])("%s reads %s", (state, text, tone) => {
    expect(getSenderVerificationStatus(makeIngress({ state }))).toEqual({ tone, text });
  });

  it.each([
    ["waiting", "Waiting for the first delivery with this hook's own token. The shared token still works until then."],
    ["closed", "Closed: only deliveries with this hook's own token are accepted."],
  ])("%s on a hook with its own token says the token, not a signature", (state, text) => {
    const status = getSenderVerificationStatus(makeIngress({ state, preset: "per_hook_token" }));
    expect(status.text).toBe(text);
  });

  it("overlap names the local time the shared token stops working", () => {
    const closesAt = "2026-11-10T18:00:00.000Z";
    const status = getSenderVerificationStatus(
      makeIngress({ state: "overlap", closesAt }),
      (value) => `local(${value})`,
    );
    expect(status).toEqual({
      tone: "ok",
      text: `Verified. The shared token stops working on this hook at local(${closesAt}).`,
    });
  });

  it("misconfigured shows the alert message in red, with a fallback when there is none", () => {
    const alert = { reason: "secret_missing", message: "The signing secret is missing.", at: null };
    expect(getSenderVerificationStatus(makeIngress({ state: "misconfigured", alert }))).toEqual({
      tone: "error",
      text: "The signing secret is missing.",
    });
    expect(getSenderVerificationStatus(makeIngress({ state: "misconfigured" }))).toEqual({
      tone: "error",
      text: "Sender verification is misconfigured.",
    });
  });

  it("an unknown or missing state shows no status line", () => {
    expect(getSenderVerificationStatus(makeIngress({ state: "later" }))).toBe(null);
    expect(getSenderVerificationStatus(null)).toBe(null);
  });
});

describe("frontend/webhook sender verification presets", () => {
  it("lists the six methods with the agreed labels", () => {
    expect(kSenderVerificationPresets.map(({ id, label }) => [id, label])).toEqual([
      ["token", "Shared webhook token (today)"],
      ["circleback", "Circleback"],
      ["quo", "Quo"],
      ["verkada", "Verkada"],
      ["standard_webhooks", "Standard Webhooks"],
      ["per_hook_token", "Own token for this hook"],
    ]);
  });

  it("prefers the server's preset list and falls back to the built-in one", () => {
    const serverPresets = [{ id: "quo", label: "Quo", secretSource: "sender", help: "From Quo settings" }];
    expect(resolvePresetOptions(makeIngress({ presets: serverPresets }))).toBe(serverPresets);
    expect(resolvePresetOptions(makeIngress())).toBe(kSenderVerificationPresets);
    expect(resolvePresetOptions(null)).toBe(kSenderVerificationPresets);
    expect(findPreset(serverPresets, "verkada")).toMatchObject({ id: "verkada", secretSource: "either" });
    expect(findPreset(serverPresets, "nope")).toBe(null);
  });
});

describe("frontend/webhook sender verification save rules", () => {
  it("a sender-held secret saves only once one is pasted", () => {
    const ingress = makeIngress();
    expect(canSaveSenderPreset({ ingress, draftPreset: "circleback", secretSource: "sender", secretDraft: "" })).toBe(false);
    expect(canSaveSenderPreset({ ingress, draftPreset: "circleback", secretSource: "sender", secretDraft: "   " })).toBe(false);
    expect(canSaveSenderPreset({ ingress, draftPreset: "circleback", secretSource: "sender", secretDraft: "pasted" })).toBe(true);
  });

  it("going back to the shared token saves only when the hook is not on it already", () => {
    expect(canSaveSenderPreset({ ingress: makeIngress(), draftPreset: "token", secretSource: "none" })).toBe(false);
    expect(
      canSaveSenderPreset({ ingress: makeIngress({ preset: "quo", state: "closed" }), draftPreset: "token", secretSource: "none" }),
    ).toBe(true);
  });

  it("an AlphaClaw-made secret never saves through PUT (it uses Generate)", () => {
    expect(canSaveSenderPreset({ ingress: makeIngress(), draftPreset: "verkada", secretSource: "alphaclaw", secretDraft: "x" })).toBe(false);
    expect(canSaveSenderPreset({ ingress: null, draftPreset: "quo", secretSource: "sender", secretDraft: "x" })).toBe(false);
  });
});

describe("frontend/webhook sender verification signing keys", () => {
  const keys = (count) => Array.from({ length: count }, (_, i) => ({ index: i + 1, addedAt: null }));

  it("a secret that can be pasted or generated saves once one is pasted", () => {
    const ingress = makeIngress();
    expect(canSaveSenderPreset({ ingress, draftPreset: "verkada", secretSource: "either", secretDraft: "" })).toBe(false);
    expect(canSaveSenderPreset({ ingress, draftPreset: "verkada", secretSource: "either", secretDraft: "pasted" })).toBe(true);
  });

  it("adds a key only to a signed hook that has one, below the limit, with a key pasted", () => {
    const quo = makeIngress({ preset: "quo", state: "waiting", hasSecret: true, signingKeys: keys(1), maxSigningKeys: 8 });
    expect(canAddSigningKey(quo, "pasted")).toBe(true);
    expect(canAddSigningKey(quo, "  ")).toBe(false);
    expect(canAddSigningKey({ ...quo, signingKeys: keys(8) }, "pasted")).toBe(false);
    expect(canAddSigningKey({ ...quo, state: "misconfigured" }, "pasted")).toBe(false);
    expect(canAddSigningKey({ ...quo, signingKeys: [] }, "pasted")).toBe(false);
    expect(canAddSigningKey(makeIngress({ preset: "per_hook_token", state: "waiting" }), "pasted")).toBe(false);
    expect(canAddSigningKey(makeIngress(), "pasted")).toBe(false);
    expect(canAddSigningKey(null, "pasted")).toBe(false);
  });
});

describe("frontend/webhook sender verification data handling", () => {
  it("never puts a shown-once secret into the shared read cache", () => {
    const ingress = makeIngress({ preset: "verkada", hasSecret: true, state: "waiting" });
    const cached = toCachedIngress({ ok: true, secret: "shown-once-value", ingress });
    expect(cached).toEqual({ ok: true, ingress });
    expect(JSON.stringify(cached)).not.toContain("shown-once-value");
  });

  it("counts read as one plain line", () => {
    expect(formatIngressCounts({ signed: 4, shared_token: 2, per_hook_token: 1, rejected: 3 })).toBe(
      "Last 500 requests: 4 signed, 2 shared token, 1 own token, 3 rejected.",
    );
    expect(formatIngressCounts({})).toBe("Last 500 requests: 0 signed, 0 shared token, 0 own token, 0 rejected.");
    expect(formatIngressCounts(null)).toBe("");
  });

  it("keys the cache per hook, encoded", () => {
    expect(getIngressCacheKey("notes")).toBe("/api/webhooks/notes/ingress");
    expect(getIngressCacheKey("a/b")).toBe("/api/webhooks/a%2Fb/ingress");
  });
});
