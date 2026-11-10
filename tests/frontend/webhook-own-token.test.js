import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCached } from "../../lib/public/js/lib/api-cache.js";
import {
  forgetOwnToken,
  getOwnToken,
  getSendTestDisabledReason,
  kHookTokenPlaceholder,
  kSendTestNeedsOwnTokenReason,
  kSendTestSignedReason,
  rememberCreatedOwnToken,
  substituteHookToken,
} from "../../lib/public/js/components/webhooks/own-token.js";

const kOwnToken = ["own", "token", "a1b2+c3/d4"].join("-");
const kHookUrl = "https://box.example.com/hooks/hook-1";
const kAuthScheme = ["Authorization:", "Bearer"].join(" ");
const kQueryUrlWithPlaceholder = `${kHookUrl}?token=${kHookTokenPlaceholder}`;
const kHeaderWithPlaceholder = [kAuthScheme, kHookTokenPlaceholder].join(" ");
const makeCreateAnswer = (ownToken) => ({
  ok: true,
  webhook: {
    name: "hook-1",
    ...(ownToken === undefined ? {} : { ownToken, hasHookToken: true, ingress: { preset: "per_hook_token" } }),
  },
});

const makeStorage = () => ({
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
});

afterEach(() => {
  forgetOwnToken("hook-1");
  vi.unstubAllGlobals();
});

describe("frontend/webhook own token substitution", () => {
  it("puts the token in the header as is and URL-encoded in the query URL", () => {
    expect(substituteHookToken(kHeaderWithPlaceholder, kOwnToken)).toBe([kAuthScheme, kOwnToken].join(" "));
    expect(substituteHookToken(kQueryUrlWithPlaceholder, kOwnToken, { encode: true })).toBe(
      `${kHookUrl}?token=${encodeURIComponent(kOwnToken)}`,
    );
  });

  it("keeps the placeholder when no token is in memory", () => {
    expect(substituteHookToken(kHeaderWithPlaceholder, "")).toBe(kHeaderWithPlaceholder);
    expect(substituteHookToken(kQueryUrlWithPlaceholder, "", { encode: true })).toBe(kQueryUrlWithPlaceholder);
  });

  it("leaves a shared-token URL untouched", () => {
    const sharedUrl = `${kHookUrl}?token=<WEBHOOK_TOKEN>`;
    expect(substituteHookToken(sharedUrl, kOwnToken, { encode: true })).toBe(sharedUrl);
  });
});

describe("frontend/webhook send test disabled reason", () => {
  it.each([
    [{ preset: "token" }, ""],
    [{ preset: undefined }, ""],
    [{ preset: "per_hook_token", hasOwnToken: true }, ""],
    [{ preset: "per_hook_token", hasOwnToken: false }, kSendTestNeedsOwnTokenReason],
    [{ preset: "circleback" }, kSendTestSignedReason],
    [{ preset: "verkada", hasOwnToken: true }, kSendTestSignedReason],
    [{ preset: "standard_webhooks" }, kSendTestSignedReason],
    [{ preset: "per_hook_token", hasOauthCallback: true }, ""],
    [{ preset: "quo", hasOauthCallback: true }, ""],
  ])("%j gives %j", (input, expected) => {
    expect(getSendTestDisabledReason(input)).toBe(expected);
  });
});

describe("frontend/webhook own token memory", () => {
  let storages;
  beforeEach(() => {
    storages = { localStorage: makeStorage(), sessionStorage: makeStorage() };
    vi.stubGlobal("localStorage", storages.localStorage);
    vi.stubGlobal("sessionStorage", storages.sessionStorage);
  });

  it("keeps the token from the create answer until it is forgotten", () => {
    expect(rememberCreatedOwnToken("hook-1", makeCreateAnswer(kOwnToken))).toBe(kOwnToken);
    expect(getOwnToken("hook-1")).toBe(kOwnToken);
    expect(getOwnToken("hook-2")).toBe("");
    forgetOwnToken("hook-1");
    expect(getOwnToken("hook-1")).toBe("");
  });

  it("forgets an older token when a create answer for the same name carries none", () => {
    rememberCreatedOwnToken("hook-1", makeCreateAnswer(kOwnToken));
    expect(rememberCreatedOwnToken("hook-1", makeCreateAnswer(undefined))).toBe("");
    expect(getOwnToken("hook-1")).toBe("");
  });

  it("never writes the token to storage or the api cache", () => {
    rememberCreatedOwnToken("hook-1", makeCreateAnswer(kOwnToken));
    getOwnToken("hook-1");
    forgetOwnToken("hook-1");
    for (const storage of Object.values(storages)) {
      expect(storage.setItem).not.toHaveBeenCalled();
    }
    for (const key of ["/api/webhooks", "/api/webhooks/hook-1", "/api/webhooks/hook-1/ingress"]) {
      expect(JSON.stringify(getCached(key) ?? null)).not.toContain(kOwnToken);
    }
  });

  it("keeps the module off storage and the api cache", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/public/js/components/webhooks/own-token.js"),
      "utf8",
    );
    expect(source).not.toMatch(/\b(localStorage|sessionStorage)\s*\./);
    expect(source).not.toMatch(/^import\b/m);
  });
});
