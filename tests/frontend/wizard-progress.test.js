import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The setup wizard, the Gmail wizard and the Telegram wizard share one step
// indicator. DOM-less harness: hooks are stubbed so components render to a
// walkable vnode tree.
vi.mock("preact/hooks", () => ({
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useRef: (v = null) => ({ current: v }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
}));
vi.mock("preact/compat", () => ({
  createPortal: (children) => children,
}));
vi.mock("../../lib/public/js/hooks/useAgentSessions.js", () => ({
  useAgentSessions: () => ({ sessions: [], loading: false, error: "" }),
}));
vi.mock("../../lib/public/js/hooks/use-destination-session-selection.js", () => ({
  kNoDestinationSessionValue: "__none__",
  useDestinationSessionSelection: () => ({
    selectedSessionKey: "",
    setSelectedSessionKey: () => {},
  }),
}));

import { WizardProgress } from "../../lib/public/js/components/wizard-progress.js";
import { WelcomeHeader } from "../../lib/public/js/components/onboarding/welcome-header.js";
import { GmailSetupWizard } from "../../lib/public/js/components/google/gmail-setup-wizard.js";
import { kWelcomeGroups } from "../../lib/public/js/components/onboarding/welcome-config.js";
import * as telegramOnboarding from "../../lib/public/js/components/telegram-workspace/onboarding.js";

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
  if (typeof node.type === "function") collectNodes(node.rendered, out);
  else if (node.props) collectNodes(node.props.children, out);
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
    if (typeof node.type === "function") collectText(node.rendered, out);
    else if (node.props) collectText(node.props.children, out);
  }
  return out;
};

const textOf = (node) => collectText(node).join("").replace(/\s+/g, " ").trim();
const render = (vnode) => expandTree(vnode);
const byType = (tree, type) => collectNodes(tree).filter((node) => node.type === type);
const progressBar = (tree) =>
  collectNodes(tree).find((node) => node.props?.role === "progressbar");
const segmentClasses = (tree) =>
  collectNodes(progressBar(tree)).filter((node) => node.type === "span").map((node) => node.props.class);

describe("frontend/wizard step indicator", () => {
  it("shows the step count, the step title as an h2 and a labelled progress bar", () => {
    const tree = render(WizardProgress({ steps: ["One", "Two", "Three"], current: 1 }));
    const count = collectNodes(tree).find((node) => node.type === "p");
    expect(textOf(count)).toBe("Step 2 of 3");
    const heading = byType(tree, "h2");
    expect(heading).toHaveLength(1);
    expect(textOf(heading[0])).toBe("Two");
    const bar = progressBar(tree);
    expect(bar.props["aria-valuetext"]).toBe("Step 2 of 3: Two");
    expect(bar.props["aria-valuenow"]).toBe("2");
    expect(bar.props["aria-valuemax"]).toBe("3");
    expect(bar.props["aria-label"]).toBeTruthy();
  });

  it("marks earlier steps done, the current step current and later steps not yet done", () => {
    const tree = render(WizardProgress({ steps: ["One", "Two", "Three", "Four"], current: 2 }));
    expect(segmentClasses(tree)).toEqual([
      "ac-wizard-progress-segment is-done",
      "ac-wizard-progress-segment is-done",
      "ac-wizard-progress-segment is-current",
      "ac-wizard-progress-segment",
    ]);
  });

  it("uses a given title in place of the step name", () => {
    const tree = render(WizardProgress({ steps: ["One", "Two"], current: 0, title: "Import" }));
    expect(textOf(byType(tree, "h2")[0])).toBe("Import");
    expect(progressBar(tree).props["aria-valuetext"]).toBe("Step 1 of 2: Import");
  });

  it("before the first step says getting started and marks no step done or current", () => {
    const tree = render(WizardProgress({ steps: ["One", "Two"], current: -1, title: "Pick a path" }));
    expect(textOf(tree)).toContain("Getting started");
    expect(textOf(tree)).not.toContain("Step 0");
    expect(progressBar(tree).props["aria-valuetext"]).toBe("Getting started: Pick a path");
    expect(segmentClasses(tree)).toEqual(["ac-wizard-progress-segment", "ac-wizard-progress-segment"]);
  });

  it("with no steps never claims a step count", () => {
    const tree = render(WizardProgress({ steps: [], current: 0, title: "Loading" }));
    expect(textOf(tree)).not.toContain("of 0");
    expect(textOf(tree)).toContain("Getting started");
    expect(progressBar(tree).props["aria-valuenow"]).toBe("0");
  });
});

describe("frontend/setup wizard header", () => {
  const header = (props) =>
    render(WelcomeHeader({ groups: kWelcomeGroups, stepNumber: 1, activeStepLabel: "", ...props }));

  it("asks how to set up this box before the first step, in plain words", () => {
    const tree = header({ isPreStep: true, stepNumber: 0, activeStepLabel: "Getting Started" });
    const text = textOf(tree);
    expect(text).toContain("Choose how to set up this box");
    expect(text).not.toMatch(/destiny/i);
    expect(byType(tree, WizardProgress)).toHaveLength(1);
  });

  it("counts the setup and pairing steps after the form steps", () => {
    const total = kWelcomeGroups.length + 2;
    const tree = header({ isPreStep: false, stepNumber: 2, activeStepLabel: kWelcomeGroups[1].title });
    const bar = progressBar(tree);
    expect(bar.props["aria-valuetext"]).toBe(`Step 2 of ${total}: ${kWelcomeGroups[1].title}`);
    expect(segmentClasses(tree)).toHaveLength(total);
    const pairing = header({ isPreStep: false, stepNumber: total, activeStepLabel: "Pairing" });
    expect(progressBar(pairing).props["aria-valuetext"]).toBe(`Step ${total} of ${total}: Pairing`);
  });
});

describe("frontend/Gmail setup wizard step indicator", () => {
  it("renders the shared step indicator once, on its first step", () => {
    const tree = render(
      GmailSetupWizard({
        visible: true,
        account: { id: "acct-1", email: "owner@example.com" },
        clientConfig: { projectId: "my-project" },
      }),
    );
    const indicators = byType(tree, WizardProgress);
    expect(indicators).toHaveLength(1);
    expect(indicators[0].props.current).toBe(0);
    expect(progressBar(tree).props["aria-valuetext"]).toMatch(/^Step 1 of \d+: /);
  });
});

describe("frontend/wizard step indicator is not copied", () => {
  const read = (file) =>
    fs.readFileSync(path.join(process.cwd(), "lib/public/js/components", file), "utf8");
  const files = [
    "onboarding/welcome-header.js",
    "google/gmail-setup-wizard.js",
    "telegram-workspace/index.js",
  ];

  it.each(files)("%s renders the shared indicator and no bar of its own", (file) => {
    const source = read(file);
    expect(source).toContain('from "../wizard-progress.js"');
    expect(source.match(/<\$\{WizardProgress\}/g)).toHaveLength(1);
    expect(source).not.toMatch(/h-1 flex-1 rounded-full/);
  });

  it("the Telegram onboarding steps no longer export their own step indicator", () => {
    expect(telegramOnboarding.StepIndicator).toBeUndefined();
  });
});
