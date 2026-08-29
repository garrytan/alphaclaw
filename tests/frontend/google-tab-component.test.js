import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as team-tab-component.test.js): hook
// state lives in per-call-index slots so component functions can be invoked
// directly without a DOM renderer. Effects are collected, not run.
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
    if (!(index in harness.slots)) {
      harness.slots[index] = { current: initialValue };
    }
    return harness.slots[index];
  };
  const useMemo = (factory) => factory();
  const useCallback = (fn) => fn;
  const useEffect = (effect) => {
    harness.effects.push(effect);
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkGoogleApis: vi.fn(),
    disconnectGoogle: vi.fn(),
    fetchGoogleCredentials: vi.fn(),
    saveGoogleAccount: vi.fn(),
  };
});

vi.mock("../../lib/public/js/components/google/use-google-accounts.js", () => ({
  useGoogleAccounts: vi.fn(),
}));

vi.mock("../../lib/public/js/components/google/use-gmail-watch.js", () => ({
  useGmailWatch: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { useGoogleAccounts } from "../../lib/public/js/components/google/use-google-accounts.js";
import { useGmailWatch } from "../../lib/public/js/components/google/use-gmail-watch.js";
import { Google } from "../../lib/public/js/components/google/index.js";
import { GoogleAccountRow } from "../../lib/public/js/components/google/account-row.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { ConfirmDialog } from "../../lib/public/js/components/confirm-dialog.js";
import { ScopePicker } from "../../lib/public/js/components/scope-picker.js";

const harness = preactHooks.__harness;

// The message-handler effect and auth popup need a window in node env.
globalThis.window = globalThis.window || {
  addEventListener: () => {},
  removeEventListener: () => {},
  open: () => null,
  alert: () => {},
  location: { origin: "http://localhost", href: "" },
  localStorage: { getItem: () => null, setItem: () => {}, clear: () => {} },
};

// Walk the RAW vnode tree (children only, never invoking function
// components) so child hooks don't pollute the harness slots.
const collectRawNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectRawNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectRawNodes(node.props.children, out);
  return out;
};

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const kAccount = {
  id: "a1",
  email: "ada@example.com",
  authenticated: true,
  activeScopes: ["gmail:read"],
  client: "default",
};

const renderGoogle = (props = {}) => {
  harness.beginRender();
  const tree = Google({ gatewayStatus: "running", ...props });
  return { tree, effects: [...harness.effects] };
};

const runEffects = (effects) => {
  for (const effect of effects) effect?.();
};

const findRow = (tree) =>
  collectRawNodes(tree).find((node) => node.type === GoogleAccountRow);

const findChip = (tree, headline) =>
  collectRawNodes(tree).find(
    (node) => node.type === InlineErrorChip && node.props.headline === headline,
  );

describe("frontend/google tab component", () => {
  let accountsHook;
  let gmailWatchHook;

  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    accountsHook = {
      accounts: [kAccount],
      loading: false,
      error: null,
      hasCompanyCredentials: true,
      hasPersonalCredentials: false,
      refreshAccounts: vi.fn(async () => {}),
    };
    gmailWatchHook = {
      loading: false,
      error: null,
      config: null,
      watchByAccountId: new Map([
        ["a1", { accountId: "a1", enabled: false, running: false }],
      ]),
      clientConfigByClient: new Map([
        ["default", { client: "default", configured: true, webhookExists: true }],
      ]),
      busyByAccountId: {},
      savingClient: false,
      refresh: vi.fn(async () => {}),
      saveClientSetup: vi.fn(async () => ({})),
      startWatchForAccount: vi.fn(async () => ({})),
      stopWatchForAccount: vi.fn(async () => {}),
      renewForAccount: vi.fn(async () => {}),
    };
    useGoogleAccounts.mockImplementation(() => accountsHook);
    useGmailWatch.mockImplementation(() => gmailWatchHook);
    api.checkGoogleApis.mockResolvedValue({ results: {} });
    api.disconnectGoogle.mockResolvedValue({ ok: true });
  });

  it("stops the auto Check APIs effect refiring after a failure and surfaces a chip", async () => {
    api.checkGoogleApis.mockRejectedValue(new Error("api check boom"));

    let r = renderGoogle();
    runEffects(r.effects);
    findRow(r.tree).props.onToggleExpanded("a1");

    r = renderGoogle();
    runEffects(r.effects);
    await flushAsync();
    expect(api.checkGoogleApis).toHaveBeenCalledTimes(1);

    // Re-render + effects again: the recorded {__error} marker must stop the
    // auto-check guard from refiring forever.
    r = renderGoogle();
    runEffects(r.effects);
    await flushAsync();
    expect(api.checkGoogleApis).toHaveBeenCalledTimes(1);

    const rowProps = findRow(r.tree).props;
    expect(rowProps.apiStatus).toEqual({ __error: "api check boom" });

    // The rendered row shows the chip and never feeds the marker to the
    // scope picker as if it were scope results.
    const rowTree = GoogleAccountRow(rowProps);
    const chip = findChip(rowTree, "Couldn't check Google API access.");
    expect(chip).toBeTruthy();
    const scopePicker = collectRawNodes(rowTree).find(
      (node) => node.type === ScopePicker,
    );
    expect(scopePicker.props.apiStatus).toEqual({});

    // Manual re-check recovers and clears the marker.
    api.checkGoogleApis.mockResolvedValue({ results: { gmail: true } });
    await chip.props.onRetry();
    r = renderGoogle();
    expect(findRow(r.tree).props.apiStatus).toEqual({ gmail: true });
  });

  it("renders a per-account inline error when the watch toggle fails, cleared on retry", async () => {
    gmailWatchHook.startWatchForAccount.mockRejectedValue(new Error("watch boom"));

    let r = renderGoogle();
    await findRow(r.tree).props.onEnableGmailWatch("a1");

    r = renderGoogle();
    let rowProps = findRow(r.tree).props;
    expect(rowProps.gmailWatchSaveError).toMatchObject({ attempted: true });
    expect(rowProps.gmailWatchSaveError.error.message).toBe("watch boom");
    expect(showToast).not.toHaveBeenCalled();

    gmailWatchHook.startWatchForAccount.mockResolvedValue({});
    await findRow(r.tree).props.onEnableGmailWatch("a1");
    r = renderGoogle();
    rowProps = findRow(r.tree).props;
    expect(rowProps.gmailWatchSaveError).toBe(null);
    expect(showToast).toHaveBeenCalledWith("Gmail watch enabled", "success");
  });

  it("passes the config load error to rows whose watch status is unknown", () => {
    gmailWatchHook.error = new Error("config boom");
    gmailWatchHook.watchByAccountId = new Map();

    const r = renderGoogle();
    const rowProps = findRow(r.tree).props;
    expect(rowProps.gmailWatchStatusError).toBe(gmailWatchHook.error);
    expect(rowProps.gmailWatchStatus).toBe(null);
  });

  it("shows an inline error with Retry instead of the empty state when accounts fail to load", () => {
    accountsHook.accounts = [];
    accountsHook.error = new Error("accounts boom");

    const { tree } = renderGoogle();
    const chip = findChip(tree, "Couldn't load Google accounts.");
    expect(chip).toBeTruthy();
    const emptyStateButtons = collectRawNodes(tree).filter(
      (node) => node.props?.idleLabel === "Add Company Account",
    );
    expect(emptyStateButtons.length).toBe(0);

    chip.props.onRetry();
    expect(accountsHook.refreshAccounts).toHaveBeenCalledTimes(1);
  });

  it("shows the loading row scoped to the list, keeping the Add Account affordance", () => {
    accountsHook.accounts = [];
    accountsHook.loading = true;

    const { tree } = renderGoogle();
    const addAccountTrigger = collectRawNodes(tree).find(
      (node) => node.props?.ariaLabel === "Add Google account",
    );
    expect(addAccountTrigger).toBeTruthy();
  });

  it("surfaces disconnect failures and exposes a pending affordance while in flight", async () => {
    api.disconnectGoogle.mockRejectedValue(new Error("net down"));

    let r = renderGoogle();
    findRow(r.tree).props.onDisconnect("a1");
    r = renderGoogle();
    const dialog = collectRawNodes(r.tree).find(
      (node) =>
        node.type === ConfirmDialog &&
        node.props.title === "Disconnect Google account?",
    );
    expect(dialog.props.visible).toBe(true);

    const confirmPromise = dialog.props.onConfirm();
    r = renderGoogle();
    expect(findRow(r.tree).props.disconnecting).toBe(true);
    const pendingDialog = collectRawNodes(r.tree).find(
      (node) =>
        node.type === ConfirmDialog &&
        node.props.title === "Disconnect Google account?",
    );
    expect(pendingDialog.props.confirmLoading).toBe(true);

    await confirmPromise;
    expect(showToast).toHaveBeenCalledWith(
      "Failed to disconnect: net down",
      "error",
    );
    r = renderGoogle();
    expect(findRow(r.tree).props.disconnecting).toBe(false);
    expect(accountsHook.refreshAccounts).not.toHaveBeenCalled();
  });

  it("routes an add-company-account throw into the modal's inline error", async () => {
    api.saveGoogleAccount.mockRejectedValue(new Error("save blew up"));

    const r = renderGoogle();
    // The modal submit path calls the same handler Google wires up.
    const setError = vi.fn();
    const addModal = collectRawNodes(r.tree).find(
      (node) => node.props?.title === "Add Company Account" && node.props?.onSubmit,
    );
    await addModal.props.onSubmit({ email: "x@y.com", setError });
    expect(setError).toHaveBeenCalledWith("save blew up");
  });
});
