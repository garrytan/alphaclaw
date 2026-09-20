import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, effects: [] };
  harness.begin = () => { harness.cursor = 0; harness.effects = []; };
  harness.reset = () => { harness.slots = []; harness.begin(); };
  const useState = (initial) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === "function" ? initial() : initial;
    return [harness.slots[index], (next) => { harness.slots[index] = typeof next === "function" ? next(harness.slots[index]) : next; }];
  };
  const useRef = (initial) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initial };
    return harness.slots[index];
  };
  return { useState, useRef, useEffect: (effect) => harness.effects.push(effect), useCallback: (fn) => fn,
    useMemo: (fn) => fn(), __harness: harness };
});
vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchOpenclawBackupPolicy: vi.fn(), updateOpenclawBackupPolicy: vi.fn(),
}));

import { __harness as harness } from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { getCached, setCached, invalidateCache } from "../../lib/public/js/lib/api-cache.js";
import { useBackupPolicy, kBackupPolicyCacheKey } from "../../lib/public/js/components/upgrade-tab/use-backup-policy.js";
import { BackupPolicyEditorView } from "../../lib/public/js/components/upgrade-tab/backup-policy-editor.js";

const defaults = { excludes: ["node_modules", "*.tmp"], rootExcludes: [] };
const document = (policy = defaults, extras = {}) => ({ ok: true, policy, defaults, refusedExcludes: [], ...extras });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const render = () => { harness.begin(); return useBackupPolicy(); };
const hydrate = async () => {
  render(); harness.effects[0](); harness.effects[1]();
  await flush(); render(); harness.effects[2](); return render();
};
const treeText = (node) => {
  if (node == null) return "";
  if (Array.isArray(node)) return node.map(treeText).join(" ");
  if (typeof node !== "object") return String(node);
  return treeText(node.props?.children);
};
const nodes = (node, result = []) => {
  if (Array.isArray(node)) node.forEach((child) => nodes(child, result));
  else if (node && typeof node === "object") { result.push(node); nodes(node.props?.children, result); }
  return result;
};

beforeEach(() => {
  harness.reset(); invalidateCache(kBackupPolicyCacheKey); vi.clearAllMocks();
  api.fetchOpenclawBackupPolicy.mockResolvedValue(document());
  api.updateOpenclawBackupPolicy.mockImplementation(async (policy) => document(policy));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("backup policy editor saved-document lifecycle", () => {
  it("loads one document and saves both lists with canonical cache refresh", async () => {
    let model = await hydrate();
    expect(api.fetchOpenclawBackupPolicy).toHaveBeenCalledOnce();
    expect(model.draft).toEqual({ excludes: "node_modules\n*.tmp", rootExcludes: "" });
    model.edit("excludes", " \nnode_modules \n*.heapsnapshot\n");
    model = render(); model.edit("rootExcludes", "state/scratch-*\n");
    model = render(); await model.save(); model = render();
    const policy = { excludes: ["node_modules", "*.heapsnapshot"], rootExcludes: ["state/scratch-*"] };
    expect(api.updateOpenclawBackupPolicy).toHaveBeenCalledExactlyOnceWith(policy);
    expect(model.dirty).toBe(false);
    expect(model.saved).toBe(true);
    expect(getCached(kBackupPolicyCacheKey).policy).toEqual(policy);
    harness.reset();
    expect(render().value.policy).toEqual(policy);
  });

  it("preserves typing when a delayed hydration GET returns", async () => {
    setCached(kBackupPolicyCacheKey, document());
    const pending = deferred(); api.fetchOpenclawBackupPolicy.mockReturnValue(pending.promise);
    let model = render(); harness.effects[0](); harness.effects[1](); harness.effects[2]();
    model = render(); model.edit("rootExcludes", "state/new-scratch-*");
    pending.resolve(document({ excludes: ["older-server-rule"], rootExcludes: [] }));
    await flush(); render(); harness.effects[2](); model = render();
    expect(model.draft.rootExcludes).toBe("state/new-scratch-*");
    expect(model.draft.excludes).toBe("node_modules\n*.tmp");
    expect(model.dirty).toBe(true);
  });

  it("does not let a pre-save GET overwrite the saved cache or canonical form", async () => {
    setCached(kBackupPolicyCacheKey, document());
    const pending = deferred(); api.fetchOpenclawBackupPolicy.mockReturnValue(pending.promise);
    let model = render(); harness.effects[0](); harness.effects[1](); harness.effects[2]();
    model = render(); model.edit("excludes", ""); model = render();
    await model.save();
    pending.resolve(document()); await flush(); render(); harness.effects[2](); model = render();
    expect(model.draft.excludes).toBe("");
    expect(getCached(kBackupPolicyCacheKey).policy.excludes).toEqual([]);
  });

  it("serializes two Save clicks before a rerender", async () => {
    let model = await hydrate(); model.edit("excludes", ""); model = render();
    const pending = deferred(); api.updateOpenclawBackupPolicy.mockReturnValue(pending.promise);
    const first = model.save(); const second = model.save();
    expect(api.updateOpenclawBackupPolicy).toHaveBeenCalledOnce();
    pending.resolve(document({ excludes: [], rootExcludes: [] }));
    await Promise.all([first, second]);
    expect(render().saving).toBe(false);
  });

  it("retains rejected text and rule errors while reconciling an uncertain save", async () => {
    let model = await hydrate(); model.edit("rootExcludes", "state"); model = render();
    const refusal = { scope: "root", pattern: "state", reason: "protected ancestor" };
    api.updateOpenclawBackupPolicy.mockRejectedValue(Object.assign(new Error("Unsafe exclusion"), { refusedExcludes: [refusal] }));
    await model.save(); model = render();
    expect(model.draft.rootExcludes).toBe("state");
    expect(model.refusedExcludes).toEqual([refusal]);
    api.fetchOpenclawBackupPolicy.mockResolvedValue(document({ excludes: ["other-client"], rootExcludes: [] }));
    harness.effects[0](); await flush(); render(); harness.effects[2](); model = render();
    expect(model.value.policy.excludes).toEqual(["other-client"]);
    expect(model.draft.rootExcludes).toBe("state");
    expect(model.saved).toBe(false);
  });

  it("Restore defaults edits the document and applies only on Save", async () => {
    api.fetchOpenclawBackupPolicy.mockResolvedValue(document({ excludes: [], rootExcludes: ["state/scratch-*"] }));
    let model = await hydrate(); model.restoreDefaults(); model = render();
    expect(model.draft).toEqual({ excludes: "node_modules\n*.tmp", rootExcludes: "" });
    expect(model.dirty).toBe(true);
    expect(api.updateOpenclawBackupPolicy).not.toHaveBeenCalled();
    await model.save();
    expect(api.updateOpenclawBackupPolicy).toHaveBeenCalledWith(defaults);
  });

  it("keeps a delayed save completion from replacing newer typing", async () => {
    let model = await hydrate(); model.edit("excludes", "first"); model = render();
    const pending = deferred(); api.updateOpenclawBackupPolicy.mockReturnValue(pending.promise);
    const saved = model.save(); model = render(); model.edit("excludes", "newer draft");
    pending.resolve(document({ excludes: ["first"], rootExcludes: [] })); await saved;
    model = render();
    expect(model.draft.excludes).toBe("newer draft");
    expect(model.dirty).toBe(true);
    expect(model.saved).toBe(false);
  });

  it("does not update the shared cache after its editor unmounts", async () => {
    let model = await hydrate();
    const stop = harness.effects[1]();
    model.edit("excludes", "after-unmount"); model = render();
    const pending = deferred(); api.updateOpenclawBackupPolicy.mockReturnValue(pending.promise);
    const saved = model.save(); stop();
    pending.resolve(document({ excludes: ["after-unmount"], rootExcludes: [] })); await saved;
    expect(getCached(kBackupPolicyCacheKey).policy).toEqual(defaults);
  });

  it("renders disabled loading/error controls and inline refusals with Retry", async () => {
    let model = render();
    let tree = BackupPolicyEditorView({ model });
    expect(nodes(tree).filter((node) => node.type === "textarea").every((node) => node.props.disabled)).toBe(true);
    expect(treeText(tree)).toContain("Loading backup exclusions");
    api.fetchOpenclawBackupPolicy.mockRejectedValue(new Error("Settings cannot be read"));
    harness.effects[0](); await flush(); model = render();
    tree = BackupPolicyEditorView({ model });
    expect(treeText(tree)).toContain("Settings cannot be read");
    expect(treeText(tree)).toContain("Retry");
    expect(nodes(tree).filter((node) => node.type === "textarea").every((node) => node.props.disabled)).toBe(true);
  });
});
