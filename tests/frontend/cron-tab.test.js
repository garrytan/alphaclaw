import { beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness (use-saved-setting.test.js pattern) extended with dep
// tracking: useEffect/useMemo record deps per slot and an effect is queued
// only when its deps changed, so tests can model poll ticks, prop changes,
// and mid-flight mutations without re-running unrelated effects — matching
// preact scheduling closely enough for the races under test.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, pendingEffects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.pendingEffects = [];
  };
  const depsChanged = (previousDeps, nextDeps) =>
    !previousDeps ||
    !nextDeps ||
    previousDeps.length !== nextDeps.length ||
    nextDeps.some((dep, index) => !Object.is(dep, previousDeps[index]));
  harness.flushEffects = () => {
    const pending = harness.pendingEffects.splice(0);
    for (const { slot, effect } of pending) {
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = effect() || null;
    }
    return pending.length;
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = {
        value: typeof initialValue === "function" ? initialValue() : initialValue,
      };
    }
    const slot = harness.slots[index];
    const setState = (next) => {
      slot.value = typeof next === "function" ? next(slot.value) : next;
    };
    return [slot.value, setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { ref: { current: initialValue } };
    }
    return harness.slots[index].ref;
  };
  const useMemo = (factory, deps) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { computed: false };
    const slot = harness.slots[index];
    if (!slot.computed || depsChanged(slot.deps, deps)) {
      slot.value = factory();
      slot.deps = deps;
      slot.computed = true;
    }
    return slot.value;
  };
  const useCallback = (fn) => fn;
  const useEffect = (effect, deps) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { ran: false, cleanup: null };
    }
    const slot = harness.slots[index];
    const changed = !slot.ran || depsChanged(slot.deps, deps);
    slot.deps = deps;
    slot.ran = true;
    if (changed) harness.pendingEffects.push({ slot, effect });
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

// usePolling stand-in: per-call-index slots the tests drive directly
// (set .data/.error, invoke .fetcher, inspect .refresh.calls). Real polling
// behavior (latest-request-wins, intervals) is covered by its own suite.
vi.mock("../../lib/public/js/hooks/usePolling.js", () => {
  const registry = { slots: [], cursor: 0 };
  registry.beginRender = () => {
    registry.cursor = 0;
  };
  const makeRefreshRecorder = () => {
    const refresh = (...args) => {
      refresh.calls.push(args);
    };
    refresh.calls = [];
    return refresh;
  };
  registry.ensureSlot = (index) => {
    if (!registry.slots[index]) {
      registry.slots[index] = {
        data: null,
        error: null,
        isPolling: false,
        refresh: makeRefreshRecorder(),
      };
    }
    return registry.slots[index];
  };
  registry.reset = () => {
    registry.slots = [];
    registry.cursor = 0;
  };
  const usePolling = (fetcher, interval, options = {}) => {
    const slot = registry.ensureSlot(registry.cursor++);
    slot.fetcher = fetcher;
    slot.options = options;
    return {
      data: slot.data,
      error: slot.error,
      refresh: slot.refresh,
      isPolling: slot.isPolling,
    };
  };
  return { usePolling, __pollRegistry: registry };
});

vi.mock(
  "../../lib/public/js/hooks/use-destination-session-selection.js",
  () => {
    const destination = {
      sessions: [],
      loading: false,
      error: "",
      destinationSessionKey: "",
      selectedDestination: null,
      setCalls: [],
    };
    destination.reset = () => {
      destination.sessions = [];
      destination.loading = false;
      destination.error = "";
      destination.destinationSessionKey = "";
      destination.selectedDestination = null;
      destination.setCalls = [];
    };
    const useDestinationSessionSelection = () => ({
      sessions: destination.sessions,
      loading: destination.loading,
      error: destination.error,
      destinationSessionKey: destination.destinationSessionKey,
      setDestinationSessionKey: (key) => destination.setCalls.push(key),
      selectedDestination: destination.selectedDestination,
    });
    return {
      useDestinationSessionSelection,
      kNoDestinationSessionValue: "__none__",
      __destinationState: destination,
    };
  },
);

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchCronBulkRuns: vi.fn(),
  fetchCronBulkUsage: vi.fn(),
  fetchCronJobRuns: vi.fn(),
  fetchCronJobTrends: vi.fn(),
  fetchCronJobs: vi.fn(),
  fetchCronJobUsage: vi.fn(),
  fetchCronStatus: vi.fn(),
  setCronJobEnabled: vi.fn(),
  triggerCronJobRun: vi.fn(),
  updateCronJobPrompt: vi.fn(),
  updateCronJobRouting: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/ui-settings.js", () => ({
  readUiSettings: vi.fn(() => ({})),
  writeUiSettings: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

// Heavy detail children are out of scope here (each has its own coverage);
// stubbing them keeps the vnode walk over index → detail → settings card.
vi.mock("../../lib/public/js/components/cron-tab/cron-prompt-editor.js", () => ({
  CronPromptEditor: () => null,
}));
vi.mock(
  "../../lib/public/js/components/cron-tab/cron-run-history-panel.js",
  () => ({ CronRunHistoryPanel: () => null }),
);
vi.mock(
  "../../lib/public/js/components/cron-tab/cron-job-trends-panel.js",
  () => ({ CronJobTrendsPanel: () => null }),
);
vi.mock("../../lib/public/js/components/cron-tab/cron-job-usage.js", () => ({
  CronJobUsage: () => null,
}));
vi.mock("../../lib/public/js/components/cron-tab/cron-overview.js", () => ({
  CronOverview: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as pollingModule from "../../lib/public/js/hooks/usePolling.js";
import * as destinationModule from "../../lib/public/js/hooks/use-destination-session-selection.js";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import {
  isRoutingDirty,
  useCronTab,
} from "../../lib/public/js/components/cron-tab/use-cron-tab.js";
import { CronTab } from "../../lib/public/js/components/cron-tab/index.js";
import { AsyncSection } from "../../lib/public/js/components/async-section.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { SavedToggle } from "../../lib/public/js/components/saved-toggle.js";
import { ToggleSwitch } from "../../lib/public/js/components/toggle-switch.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";

const harness = preactHooks.__harness;
const polls = pollingModule.__pollRegistry;
const destination = destinationModule.__destinationState;

// usePolling call order inside useCronTab.
const kJobsPoll = 0;
const kRunsPoll = 2;
const kUsagePoll = 3;
const kTrendsPoll = 4;

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeJob = (overrides = {}) => ({
  id: "job-1",
  name: "Job One",
  enabled: true,
  sessionTarget: "main",
  wakeMode: "now",
  delivery: { mode: "none", channel: "", to: "" },
  payload: { kind: "agentTurn", message: "hello" },
  schedule: { kind: "cron", expr: "0 9 * * *" },
  state: { nextRunAtMs: 0 },
  ...overrides,
});

const makeRuns = (count, startIndex = 0) =>
  Array.from({ length: count }, (_, index) => ({
    id: `run-${startIndex + index}`,
    ts: 1700000000000 + (startIndex + index) * 1000,
    status: "ok",
  }));

const renderHookOnce = (props) => {
  harness.beginRender();
  polls.beginRender();
  return useCronTab(props);
};

// Render → flush changed effects → settle async state until stable.
const settleHook = async (props) => {
  let result = renderHookOnce(props);
  for (let i = 0; i < 10; i += 1) {
    const ran = harness.flushEffects();
    await flushAsync();
    result = renderHookOnce(props);
    if (!ran && harness.pendingEffects.length === 0) break;
  }
  return result;
};

// --- vnode-walk helpers (saved-toggle-component.test.js pattern) ---
const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch {
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) {
    out.props = { ...out.props, children: expandTree(out.props.children) };
  }
  return out;
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  if (node.rendered) collectNodes(node.rendered, out);
  return out;
};

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
    if (node.props) collectText(node.props.children, out);
    if (node.rendered) collectText(node.rendered, out);
  }
  return out;
};

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const renderComponentOnce = (props) => {
  harness.beginRender();
  polls.beginRender();
  return expandTree(CronTab(props));
};

const settleComponent = async (props) => {
  let tree = renderComponentOnce(props);
  for (let i = 0; i < 10; i += 1) {
    const ran = harness.flushEffects();
    await flushAsync();
    tree = renderComponentOnce(props);
    if (!ran && harness.pendingEffects.length === 0) break;
  }
  return tree;
};

beforeEach(() => {
  harness.reset();
  polls.reset();
  destination.reset();
  vi.clearAllMocks();
  api.fetchCronJobs.mockResolvedValue({ ok: true, jobs: [] });
  api.fetchCronStatus.mockResolvedValue({ ok: true, status: null });
  api.fetchCronJobRuns.mockResolvedValue({
    ok: true,
    runs: { entries: [], hasMore: false, nextOffset: 0, total: 0 },
  });
  api.fetchCronJobUsage.mockResolvedValue({ ok: true, usage: null });
  api.fetchCronJobTrends.mockResolvedValue({ ok: true, trends: null });
  api.fetchCronBulkUsage.mockResolvedValue({ ok: true, usage: { byJobId: {} } });
  api.fetchCronBulkRuns.mockResolvedValue({ ok: true, runs: { byJobId: {} } });
  api.setCronJobEnabled.mockResolvedValue({ ok: true });
  api.triggerCronJobRun.mockResolvedValue({ ok: true });
  api.updateCronJobPrompt.mockResolvedValue({ ok: true });
  api.updateCronJobRouting.mockResolvedValue({ ok: true });
});

describe("frontend/cron-tab isRoutingDirty", () => {
  const job = makeJob({
    sessionTarget: "main",
    wakeMode: "now",
    delivery: { mode: "announce", channel: "telegram", to: "111" },
  });

  it("is clean when the draft matches the job's saved routing", () => {
    const draft = {
      sessionTarget: "main",
      wakeMode: "now",
      deliveryMode: "announce",
      deliveryChannel: "telegram",
      deliveryTo: "111",
    };
    expect(isRoutingDirty(draft, job)).toBe(false);
    expect(isRoutingDirty(null, job)).toBe(false);
  });

  it("flags delivery destination changes even when the mode is unchanged", () => {
    const base = {
      sessionTarget: "main",
      wakeMode: "now",
      deliveryMode: "announce",
      deliveryChannel: "telegram",
      deliveryTo: "111",
    };
    expect(isRoutingDirty({ ...base, deliveryTo: "222" }, job)).toBe(true);
    expect(isRoutingDirty({ ...base, deliveryChannel: "slack" }, job)).toBe(true);
    expect(
      isRoutingDirty(
        { ...base, deliveryMode: "none", deliveryChannel: "", deliveryTo: "" },
        job,
      ),
    ).toBe(true);
  });

  it("still flags session target and wake mode changes", () => {
    const base = {
      sessionTarget: "main",
      wakeMode: "now",
      deliveryMode: "announce",
      deliveryChannel: "telegram",
      deliveryTo: "111",
    };
    expect(isRoutingDirty({ ...base, sessionTarget: "isolated" }, job)).toBe(true);
    expect(isRoutingDirty({ ...base, wakeMode: "next-heartbeat" }, job)).toBe(true);
  });
});

describe("frontend/cron-tab optimistic enable toggle", () => {
  it("flips instantly, survives stale poll snapshots, and holds until the poll confirms", async () => {
    polls.ensureSlot(kJobsPoll).data = { ok: true, jobs: [makeJob()] };
    let hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.selectedJobEnabled).toBe(true);

    const gate = deferred();
    api.setCronJobEnabled.mockReturnValue(gate.promise);
    const togglePromise = hook.actions.setSelectedJobEnabled(false);
    hook = renderHookOnce({ jobId: "job-1" });
    expect(hook.state.selectedJobEnabled).toBe(false); // instant flip
    expect(hook.state.togglingJobEnabled).toBe(true);

    // A poll snapshot dispatched before the mutation still says enabled —
    // it may not clobber the in-flight toggle.
    polls.slots[kJobsPoll].data = { ok: true, jobs: [makeJob()] };
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.selectedJobEnabled).toBe(false);

    gate.resolve({ ok: true });
    await togglePromise;
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.togglingJobEnabled).toBe(false);
    // Just-committed: still held even though the poll data says enabled.
    expect(hook.state.selectedJobEnabled).toBe(false);
    expect(polls.slots[kJobsPoll].refresh.calls.length).toBeGreaterThan(0);
    expect(showToast).toHaveBeenCalledWith("Cron job disabled", "success");

    // Poll reports the committed value → converge; external changes show
    // through again afterwards.
    polls.slots[kJobsPoll].data = { ok: true, jobs: [makeJob({ enabled: false })] };
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.selectedJobEnabled).toBe(false);
    polls.slots[kJobsPoll].data = { ok: true, jobs: [makeJob({ enabled: true })] };
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.selectedJobEnabled).toBe(true);
  });

  it("reverts loudly on failure: inline error, reconcile refresh, no error toast", async () => {
    polls.ensureSlot(kJobsPoll).data = { ok: true, jobs: [makeJob()] };
    let hook = await settleHook({ jobId: "job-1" });

    api.setCronJobEnabled.mockRejectedValue(new Error("boom"));
    await hook.actions.setSelectedJobEnabled(false);
    hook = await settleHook({ jobId: "job-1" });

    expect(hook.state.selectedJobEnabled).toBe(true); // reverted to server value
    expect(hook.state.togglingJobEnabled).toBe(false);
    expect(hook.state.enableSaveError?.attempted).toBe(false);
    expect(hook.state.enableSaveError?.error?.message).toBe("boom");
    expect(showToast).not.toHaveBeenCalled();
    expect(polls.slots[kJobsPoll].refresh.calls.length).toBeGreaterThan(0);
  });

  it("clears the error and override when switching jobs", async () => {
    polls.ensureSlot(kJobsPoll).data = {
      ok: true,
      jobs: [makeJob(), makeJob({ id: "job-2", enabled: false })],
    };
    let hook = await settleHook({ jobId: "job-1" });
    api.setCronJobEnabled.mockRejectedValue(new Error("boom"));
    await hook.actions.setSelectedJobEnabled(false);
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.enableSaveError).toBeTruthy();

    hook = await settleHook({ jobId: "job-2" });
    expect(hook.state.enableSaveError).toBe(null);
    expect(hook.state.selectedJobEnabled).toBe(false); // job-2's own value
  });
});

describe("frontend/cron-tab delivery destination seeding", () => {
  const row111 = {
    key: "agent:main:telegram:group:111",
    replyChannel: "telegram",
    replyTo: "111",
  };
  const row222 = {
    key: "agent:main:telegram:group:222",
    replyChannel: "telegram",
    replyTo: "222",
  };

  it("seeds the select from the job's saved destination without rewriting the draft", async () => {
    destination.sessions = [row111, row222];
    destination.destinationSessionKey = row222.key; // preferred/default session
    destination.selectedDestination = { channel: "telegram", to: "222" };
    polls.ensureSlot(kJobsPoll).data = {
      ok: true,
      jobs: [
        makeJob({ delivery: { mode: "announce", channel: "telegram", to: "111" } }),
      ],
    };

    const hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.destinationSessionKey).toBe(row111.key);
    expect(hook.state.routingDraft.deliveryChannel).toBe("telegram");
    expect(hook.state.routingDraft.deliveryTo).toBe("111"); // saved value kept
  });

  it("rewrites the draft only after an explicit manual selection", async () => {
    destination.sessions = [row111, row222];
    destination.destinationSessionKey = row222.key;
    destination.selectedDestination = { channel: "telegram", to: "222" };
    polls.ensureSlot(kJobsPoll).data = {
      ok: true,
      jobs: [
        makeJob({ delivery: { mode: "announce", channel: "telegram", to: "111" } }),
      ],
    };
    let hook = await settleHook({ jobId: "job-1" });

    hook.actions.setDestinationSessionKey(row222.key);
    expect(destination.setCalls).toEqual([row222.key]);
    destination.destinationSessionKey = row222.key;
    hook = await settleHook({ jobId: "job-1" });

    expect(hook.state.destinationSessionKey).toBe(row222.key);
    expect(hook.state.routingDraft.deliveryTo).toBe("222");
  });
});

describe("frontend/cron-tab run pagination vs poll", () => {
  const seedFirstPage = async () => {
    polls.ensureSlot(kJobsPoll).data = { ok: true, jobs: [makeJob()] };
    let hook = await settleHook({ jobId: "job-1" });
    polls.slots[kRunsPoll].data = {
      ok: true,
      runs: { entries: makeRuns(25), hasMore: true, nextOffset: 25, total: 60 },
    };
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.runEntries).toHaveLength(25);
    return hook;
  };

  it("polls with a limit covering everything paged in so far", async () => {
    let hook = await seedFirstPage();
    api.fetchCronJobRuns.mockResolvedValue({
      ok: true,
      runs: { entries: makeRuns(25, 25), hasMore: false, nextOffset: 50, total: 50 },
    });
    await hook.actions.loadMoreRuns();
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.runEntries).toHaveLength(50);

    api.fetchCronJobRuns.mockClear();
    await polls.slots[kRunsPoll].fetcher();
    expect(api.fetchCronJobRuns).toHaveBeenCalledWith("job-1", {
      limit: 50,
      offset: 0,
      status: "all",
      sortDir: "desc",
    });
  });

  it("ignores a truncated poll snapshot while paginated, accepts genuine shrink", async () => {
    let hook = await seedFirstPage();
    api.fetchCronJobRuns.mockResolvedValue({
      ok: true,
      runs: { entries: makeRuns(25, 25), hasMore: false, nextOffset: 50, total: 50 },
    });
    await hook.actions.loadMoreRuns();
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.runEntries).toHaveLength(50);

    // Stale page-1 snapshot (hasMore) may not wipe the paged-in entries.
    polls.slots[kRunsPoll].data = {
      ok: true,
      runs: { entries: makeRuns(25), hasMore: true, nextOffset: 25, total: 60 },
    };
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.runEntries).toHaveLength(50);

    // A complete snapshot (no more pages) is the server truth — accept it.
    polls.slots[kRunsPoll].data = {
      ok: true,
      runs: { entries: makeRuns(10), hasMore: false, nextOffset: 10, total: 10 },
    };
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.runEntries).toHaveLength(10);
  });

  it("discards a stale Load More response after the job changed", async () => {
    const hook = await seedFirstPage();
    const gate = deferred();
    api.fetchCronJobRuns.mockReturnValue(gate.promise);
    const loadPromise = hook.actions.loadMoreRuns();

    let switched = await settleHook({ jobId: "job-2" });
    gate.resolve({
      ok: true,
      runs: { entries: makeRuns(25, 25), hasMore: false, nextOffset: 50, total: 50 },
    });
    await loadPromise;
    switched = await settleHook({ jobId: "job-2" });
    expect(switched.state.runEntries).toHaveLength(0);
  });
});

describe("frontend/cron-tab draft merge on poll", () => {
  it("keeps a dirty prompt draft while advancing the saved baseline", async () => {
    polls.ensureSlot(kJobsPoll).data = { ok: true, jobs: [makeJob()] };
    let hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.promptValue).toBe("hello");

    hook.actions.setPromptValue("draft edit");
    hook = await settleHook({ jobId: "job-1" });
    polls.slots[kJobsPoll].data = {
      ok: true,
      jobs: [makeJob({ payload: { kind: "agentTurn", message: "hello v2" } })],
    };
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.promptValue).toBe("draft edit");
    expect(hook.state.savedPromptValue).toBe("hello v2");
  });

  it("follows the server prompt when the draft is clean", async () => {
    polls.ensureSlot(kJobsPoll).data = { ok: true, jobs: [makeJob()] };
    let hook = await settleHook({ jobId: "job-1" });
    polls.slots[kJobsPoll].data = {
      ok: true,
      jobs: [makeJob({ payload: { kind: "agentTurn", message: "hello v2" } })],
    };
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.promptValue).toBe("hello v2");
    expect(hook.state.savedPromptValue).toBe("hello v2");
  });

  it("keeps a dirty routing draft when the poll changes the job", async () => {
    polls.ensureSlot(kJobsPoll).data = { ok: true, jobs: [makeJob()] };
    let hook = await settleHook({ jobId: "job-1" });
    hook.actions.setRoutingDraft((currentValue) => ({
      ...currentValue,
      wakeMode: "next-heartbeat",
    }));
    hook = await settleHook({ jobId: "job-1" });

    polls.slots[kJobsPoll].data = {
      ok: true,
      jobs: [makeJob({ sessionTarget: "isolated" })],
    };
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.routingDraft.wakeMode).toBe("next-heartbeat");
    expect(hook.state.routingDraft.sessionTarget).toBe("main");
  });

  it("follows the server routing when the draft is clean and reseeds on job switch", async () => {
    polls.ensureSlot(kJobsPoll).data = {
      ok: true,
      jobs: [makeJob(), makeJob({ id: "job-2", wakeMode: "next-heartbeat" })],
    };
    let hook = await settleHook({ jobId: "job-1" });
    polls.slots[kJobsPoll].data = {
      ok: true,
      jobs: [
        makeJob({ wakeMode: "next-heartbeat" }),
        makeJob({ id: "job-2", wakeMode: "next-heartbeat" }),
      ],
    };
    hook = await settleHook({ jobId: "job-1" });
    expect(hook.state.routingDraft.wakeMode).toBe("next-heartbeat");

    // Dirty draft on job-1 must still reseed when navigating to job-2.
    hook.actions.setRoutingDraft((currentValue) => ({
      ...currentValue,
      sessionTarget: "isolated",
    }));
    hook = await settleHook({ jobId: "job-1" });
    hook = await settleHook({ jobId: "job-2" });
    expect(hook.state.routingDraft.sessionTarget).toBe("main");
    expect(hook.state.routingDraft.wakeMode).toBe("next-heartbeat");
  });
});

describe("frontend/cron-tab selection refresh", () => {
  it("skips the duplicate refresh when the poll was just enabled", async () => {
    polls.ensureSlot(kJobsPoll).data = {
      ok: true,
      jobs: [makeJob(), makeJob({ id: "job-2" })],
    };
    let hook = await settleHook({ jobId: "" });
    hook = await settleHook({ jobId: "job-1" });
    expect(polls.slots[kRunsPoll].refresh.calls).toHaveLength(0);
    expect(polls.slots[kUsagePoll].refresh.calls).toHaveLength(0);
    expect(polls.slots[kTrendsPoll].refresh.calls).toHaveLength(0);

    hook.actions.setRunStatusFilter("error");
    hook = await settleHook({ jobId: "job-1" });
    expect(polls.slots[kRunsPoll].refresh.calls).toHaveLength(1);

    await settleHook({ jobId: "job-2" });
    expect(polls.slots[kRunsPoll].refresh.calls).toHaveLength(2);
    expect(polls.slots[kUsagePoll].refresh.calls).toHaveLength(1);
    expect(polls.slots[kTrendsPoll].refresh.calls).toHaveLength(1);
  });
});

describe("frontend/cron-tab component region states", () => {
  it("renders a load-error chip with Retry instead of the empty state", async () => {
    polls.ensureSlot(kJobsPoll).error = new Error("fetch failed");
    const tree = await settleComponent({ jobId: "" });

    const section = findAllByType(tree, AsyncSection)[0];
    expect(section.props.error).toBeTruthy();
    const chip = findAllByType(section.rendered, InlineErrorChip)[0];
    expect(chip.props.headline).toBe("Couldn't load cron jobs.");
    expect(collectText(section.rendered).join(" ")).not.toContain(
      "No cron jobs yet",
    );

    chip.props.onRetry();
    expect(polls.slots[kJobsPoll].refresh.calls.length).toBeGreaterThan(0);
  });

  it("renders a loading placeholder before the first jobs payload", async () => {
    const tree = await settleComponent({ jobId: "" });
    const section = findAllByType(tree, AsyncSection)[0];
    expect(section.props.loading).toBe(true);
    const renderedText = collectText(section.rendered).join(" ");
    expect(renderedText).toContain("Loading cron jobs...");
    expect(renderedText).not.toContain("No cron jobs yet");
  });

  it("renders the empty state only once jobs have genuinely loaded empty", async () => {
    polls.ensureSlot(kJobsPoll).data = { ok: true, jobs: [] };
    const tree = await settleComponent({ jobId: "" });
    const section = findAllByType(tree, AsyncSection)[0];
    expect(section.props.loading).toBe(false);
    expect(section.props.error).toBe(null);
    expect(collectText(section.rendered).join(" ")).toContain("No cron jobs yet");
  });

  it("renders runs/usage/trends poll errors as inline rows in the detail pane", async () => {
    polls.ensureSlot(kJobsPoll).data = { ok: true, jobs: [makeJob()] };
    polls.ensureSlot(kRunsPoll).error = new Error("runs down");
    polls.ensureSlot(kUsagePoll).error = new Error("usage down");
    polls.ensureSlot(kTrendsPoll).error = new Error("trends down");
    const tree = await settleComponent({ jobId: "job-1" });

    const headlines = findAllByType(tree, InlineErrorChip).map(
      (chip) => chip.props.headline,
    );
    expect(headlines).toContain("Couldn't load run history.");
    expect(headlines).toContain("Couldn't load usage.");
    expect(headlines).toContain("Couldn't load trends.");
  });
});

describe("frontend/cron-tab component save + toggle wiring", () => {
  const row111 = {
    key: "agent:main:telegram:group:111",
    replyChannel: "telegram",
    replyTo: "111",
    groupName: "Group 111",
  };
  const row222 = {
    key: "agent:main:telegram:group:222",
    replyChannel: "telegram",
    replyTo: "222",
    groupName: "Group 222",
  };

  const findSaveButton = (tree) =>
    findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Save changes",
    );
  const findRunNowButton = (tree) =>
    findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Run now",
    );

  it("enables Save when only the delivery destination changed", async () => {
    destination.sessions = [row111, row222];
    destination.destinationSessionKey = row111.key;
    destination.selectedDestination = { channel: "telegram", to: "111" };
    polls.ensureSlot(kJobsPoll).data = {
      ok: true,
      jobs: [
        makeJob({ delivery: { mode: "announce", channel: "telegram", to: "111" } }),
      ],
    };
    let tree = await settleComponent({ jobId: "job-1" });
    expect(findSaveButton(tree).props.disabled).toBe(true);
    expect(findRunNowButton(tree).props.disabled).toBe(false);

    const select = findAllByType(tree, "select")[0];
    // preact/compat (pulled in via Tooltip) lowercases DOM event props.
    const onSelectInput = select.props.oninput || select.props.onInput;
    onSelectInput({ currentTarget: { value: row222.key } });
    destination.destinationSessionKey = row222.key;
    destination.selectedDestination = { channel: "telegram", to: "222" };
    tree = await settleComponent({ jobId: "job-1" });

    // Delivery mode is still "announce"; only channel/to changed — the Save
    // button must see it as dirty (and Run now blocks on unsaved changes).
    expect(findSaveButton(tree).props.disabled).toBe(false);
    expect(findRunNowButton(tree).props.disabled).toBe(true);
  });

  it("shows Saving... on the toggle mid-flight and an inline chip on failure", async () => {
    polls.ensureSlot(kJobsPoll).data = { ok: true, jobs: [makeJob()] };
    let tree = await settleComponent({ jobId: "job-1" });
    let toggle = findAllByType(tree, SavedToggle)[0];
    expect(toggle.props.value).toBe(true);

    const gate = deferred();
    api.setCronJobEnabled.mockReturnValue(gate.promise);
    const togglePromise = toggle.props.onChange(false);
    tree = renderComponentOnce({ jobId: "job-1" });
    toggle = findAllByType(tree, SavedToggle)[0];
    expect(toggle.props.value).toBe(false);
    expect(toggle.props.saving).toBe(true);
    const toggleSwitch = findAllByType(toggle.rendered, ToggleSwitch)[0];
    expect(toggleSwitch.props.label).toBe("Saving...");

    gate.reject(new Error("boom"));
    await togglePromise;
    tree = await settleComponent({ jobId: "job-1" });
    toggle = findAllByType(tree, SavedToggle)[0];
    expect(toggle.props.value).toBe(true); // loud revert
    const chip = findAllByType(toggle.rendered, InlineErrorChip)[0];
    expect(chip.props.headline).toBe(
      "Couldn't confirm disable — showing the server's current state.",
    );
    expect(showToast).not.toHaveBeenCalled();
  });
});
