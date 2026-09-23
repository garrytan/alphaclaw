import { describe, expect, it, vi } from "vitest";

// Minimal hook harness (upgrade-tab.test.js pattern): these components only
// need useMemo/useState to be callable outside a DOM renderer.
vi.mock("preact/hooks", () => {
  const slots = [];
  let cursor = 0;
  const useState = (initialValue) => {
    const index = cursor++;
    if (!(index in slots)) {
      slots[index] =
        typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (next) => {
      slots[index] = typeof next === "function" ? next(slots[index]) : next;
    };
    return [slots[index], setState];
  };
  const useRef = (initialValue = null) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = { current: initialValue };
    return slots[index];
  };
  return {
    useState,
    useRef,
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useContext: () => null,
  };
});

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import { CronJobDetail } from "../../lib/public/js/components/cron-tab/cron-job-detail.js";
import { CronJobSettingsCard } from "../../lib/public/js/components/cron-tab/cron-job-settings-card.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { SavedToggle } from "../../lib/public/js/components/saved-toggle.js";
import { CronJobUsage } from "../../lib/public/js/components/cron-tab/cron-job-usage.js";
import { CronJobTrendsPanel } from "../../lib/public/js/components/cron-tab/cron-job-trends-panel.js";
import { CronRunHistoryPanel } from "../../lib/public/js/components/cron-tab/cron-run-history-panel.js";

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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const kJob = {
  id: "job-1",
  name: "Nightly report",
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * *" },
  sessionTarget: "main",
  wakeMode: "now",
  delivery: { mode: "none" },
  state: {},
};

describe("frontend/cron-tab job detail load failures", () => {
  it("does not present failed first loads as zero usage or empty history, but keeps previously loaded results", () => {
    const failures = { job: kJob, runsError: new Error("unavailable"), usageError: new Error("unavailable"), trendsError: new Error("unavailable") };
    const empty = expandTree(CronJobDetail(failures));
    for (const panel of [CronJobUsage, CronJobTrendsPanel, CronRunHistoryPanel]) expect(findAllByType(empty, panel)).toHaveLength(0);
    expect(findAllByType(empty, InlineErrorChip)).toHaveLength(3);
    const loaded = expandTree(CronJobDetail({ ...failures, usage: { totals: { runCount: 1 } }, jobTrends: { points: [] }, runEntries: [{ ts: 100, status: "ok" }], runTotal: 1 }));
    for (const panel of [CronJobUsage, CronJobTrendsPanel, CronRunHistoryPanel]) expect(findAllByType(loaded, panel)).toHaveLength(1);
  });

  it("renders a retry-wired chip per failed panel load and none when clean", () => {
    const onRetryLoads = vi.fn();
    const tree = expandTree(
      CronJobDetail({
        job: kJob,
        runsError: new Error("runs down"),
        usageError: new Error("usage down"),
        trendsError: new Error("trends down"),
        onRetryLoads,
      }),
    );
    const chips = findAllByType(tree, InlineErrorChip).filter(
      (chip) => chip.props.onRetry === onRetryLoads,
    );
    expect(chips.map((chip) => chip.props.headline).sort()).toEqual([
      "Couldn't load run history.",
      "Couldn't load trends.",
      "Couldn't load usage.",
    ]);

    const clean = expandTree(CronJobDetail({ job: kJob }));
    expect(
      findAllByType(clean, InlineErrorChip).filter((chip) => chip.props.error),
    ).toEqual([]);
  });
});

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

const treeText = (tree) => collectText(tree).join(" ");

describe("frontend/cron-tab usage metric labels", () => {
  it("identifies model-ledger counts separately from cron-history duration without changing metric values", () => {
    const tree = expandTree(CronJobUsage({ usage: { totals: { runCount: 2, totalTokens: 100, totalCost: 0.04, avgDurationMs: 1200 } } }));
    const text = treeText(tree);
    expect(text).toContain("Model runs 2");
    expect(text).toContain("Avg tokens/model run 50");
    expect(text).toContain("Avg cost/model run $0.02");
    expect(text).toContain("Avg job duration");
    expect(text).not.toContain("Total runs");
    const systemEvent = treeText(expandTree(CronJobUsage({ usage: { totals: { runCount: 0, avgDurationMs: 10 } } })));
    expect(systemEvent).toContain("Model runs 0");
    expect(systemEvent).toContain("10ms");
  });
});

// Expected values are computed through the same Intl presets production uses
// (format.js timeStyle short / dateStyle medium), so assertions stay locale-
// and timezone-agnostic in CI.
const kTime = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const kDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

describe("frontend/cron-tab settings-card next-run absolute label", () => {
  const renderCardText = (nextRunAtMs) =>
    treeText(
      expandTree(
        CronJobSettingsCard({
          job: { ...kJob, state: { nextRunAtMs } },
        }),
      ),
    );

  it("shows time-only for a next run later today", () => {
    // "Now" itself is always the same local day as the render's own now.
    const ts = Date.now();
    expect(renderCardText(ts)).toContain(kTime.format(new Date(ts)));
  });

  it("prefixes Tomorrow for a next run on the next local day", () => {
    // Built exactly like the component's tomorrowValue (setDate(+1)), so the
    // expectation holds across DST and month boundaries.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const text = renderCardText(tomorrow.getTime());
    expect(text).toContain(`Tomorrow ${kTime.format(tomorrow)}`);
  });

  it("shows the full locale date-time beyond tomorrow and an em-dash for no next run", () => {
    const farDate = new Date();
    farDate.setDate(farDate.getDate() + 10);
    expect(renderCardText(farDate.getTime())).toContain(
      kDateTime.format(farDate),
    );
    expect(renderCardText(0)).toContain("—");
  });
});

describe("frontend/cron-tab settings-card enable toggle", () => {
  it("wires the SavedToggle to server-confirmed state, save errors, and the still-X describe copy", () => {
    const enableSaveError = {
      attempted: true,
      error: new Error("enable failed"),
      context: null,
    };
    const tree = expandTree(
      CronJobSettingsCard({
        job: kJob,
        jobEnabled: false,
        togglingJobEnabled: true,
        enableSaveError,
        savingChanges: true,
      }),
    );
    const toggle = findAllByType(tree, SavedToggle)[0];
    expect(toggle).toBeTruthy();
    // Renders the dedicated prop (server-confirmed), not job.enabled.
    expect(toggle.props.value).toBe(false);
    expect(toggle.props.hydrated).toBe(true);
    expect(toggle.props.saving).toBe(true);
    expect(toggle.props.saveError).toBe(enableSaveError);
    expect(toggle.props.disabled).toBe(true);
    expect(toggle.props.describe(true)).toBe(
      "Couldn't confirm enable — showing the server's current state.",
    );
    expect(toggle.props.describe(false)).toBe(
      "Couldn't confirm disable — showing the server's current state.",
    );
  });
});
