import { beforeEach, describe, expect, it, vi } from "vitest";

// Same minimal hook harness as google-tab-component.test.js: hook state lives
// in per-call-index slots so the component can be invoked directly.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, effects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
    harness.effects = [];
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.effects = [];
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] =
        typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (next) => {
      harness.slots[index] =
        typeof next === "function" ? next(harness.slots[index]) : next;
    };
    return [harness.slots[index], setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initialValue };
    return harness.slots[index];
  };
  const useMemo = (factory) => factory();
  const useCallback = (fn) => fn;
  const useEffect = (effect) => {
    harness.effects.push(effect);
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchBuzzSetup: vi.fn(),
  runBuzzSetupAction: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

vi.mock("../../lib/public/js/lib/clipboard.js", () => ({
  copyTextToClipboard: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { BuzzWizard } from "../../lib/public/js/components/channels/buzz-wizard.js";
import { WizardShell } from "../../lib/public/js/components/wizard-shell.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";

const harness = preactHooks.__harness;

const collectRawNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectRawNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) {
    collectRawNodes(node.props.children, out);
    collectRawNodes(node.props.footer, out);
  }
  return out;
};

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// Render once, run the mount effect (which resumes at the server's step), then
// re-render so the footer reflects the resumed step.
const renderAtInstalledStep = async (onClose) => {
  api.fetchBuzzSetup.mockResolvedValue({ state: { status: "installed" } });
  harness.beginRender();
  BuzzWizard({ visible: true, onClose });
  for (const effect of harness.effects) effect?.();
  await flushAsync();
  harness.beginRender();
  const tree = BuzzWizard({ visible: true, onClose });
  const shell = collectRawNodes(tree).find((node) => node.type === WizardShell);
  const pause = collectRawNodes(shell?.props?.footer).find(
    (node) => node.type === ActionButton && node.props?.idleLabel === "Pause setup",
  );
  return { tree, pause };
};

describe("frontend/channels buzz wizard — Pause setup (F169)", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  it("toasts 'paused' and closes only when the cancel POST succeeded", async () => {
    const onClose = vi.fn();
    api.runBuzzSetupAction.mockResolvedValue({ state: { status: "paused" } });
    const { pause } = await renderAtInstalledStep(onClose);
    expect(pause).toBeTruthy();
    await pause.props.onClick();
    expect(api.runBuzzSetupAction).toHaveBeenCalledWith("cancel", {});
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Buzz setup paused"), "info");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a failed cancel keeps the wizard open with the inline error and NO 'paused' toast", async () => {
    const onClose = vi.fn();
    api.runBuzzSetupAction.mockRejectedValue(Object.assign(new Error("cancel failed"), { hint: "try again" }));
    const { pause } = await renderAtInstalledStep(onClose);
    expect(pause).toBeTruthy();
    await pause.props.onClick();
    expect(showToast).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The inline error state was set (rendered on the next pass).
    harness.beginRender();
    const tree = BuzzWizard({ visible: true, onClose });
    const errorText = JSON.stringify(collectRawNodes(tree).map((node) => node.props?.children ?? null));
    expect(errorText).toContain("cancel failed");
  });
});
