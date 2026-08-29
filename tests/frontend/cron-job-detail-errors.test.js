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
