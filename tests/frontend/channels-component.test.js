import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as team-tab-component tests): state
// lives in per-call-index slots, effects are collected without running.
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

vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: vi.fn(),
}));

vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: vi.fn(() => ({ data: null, loading: false, refresh: vi.fn() })),
}));

vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  deleteChannelAccount: vi.fn(),
  fetchChannelAccounts: vi.fn(),
  fetchChannelAccountLoginStatus: vi.fn(),
  fetchRestartStatus: vi.fn(),
  runChannelAccountLogin: vi.fn(),
  updateChannelAccount: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import {
  Channels,
  ChannelsCard,
} from "../../lib/public/js/components/channels.js";
import { ChannelAccountStatusBadge } from "../../lib/public/js/components/channel-account-status-badge.js";
import { ConfirmDialog } from "../../lib/public/js/components/confirm-dialog.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import * as preactHooks from "preact/hooks";

const harness = preactHooks.__harness;

// useState call order in Channels (see component source; useCachedFetch and
// usePolling are module-mocked so they consume no slots).
const kDeletingAccountSlot = 4;

const collectNodes = (vnode, out = []) => {
  if (vnode == null || typeof vnode !== "object") return out;
  if (Array.isArray(vnode)) {
    for (const child of vnode) collectNodes(child, out);
    return out;
  }
  out.push(vnode);
  if (vnode.props) collectNodes(vnode.props.children, out);
  return out;
};

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const renderChannels = (props = {}) => {
  harness.beginRender();
  return Channels({ channels: null, agents: [], ...props });
};

const kTelegramAccountsPayload = {
  channels: [
    {
      channel: "telegram",
      accounts: [{ id: "default", status: "paired" }],
    },
  ],
};

describe("frontend/channels component", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    useCachedFetch.mockReturnValue({
      data: kTelegramAccountsPayload,
      loading: false,
      refresh: vi.fn().mockResolvedValue(kTelegramAccountsPayload),
    });
    api.deleteChannelAccount.mockResolvedValue({});
  });

  afterEach(() => {
    harness.reset();
  });

  it("renders account rows even before the statuses fetch lands, using account-level status", () => {
    const tree = renderChannels({ channels: null });

    const card = collectNodes(tree).find((vnode) => vnode.type === ChannelsCard);
    expect(card).toBeTruthy();
    expect(card.props.items).toHaveLength(1);
    expect(card.props.items[0].channel).toBe("telegram");

    const badge = collectNodes(card.props.items[0].trailing).find(
      (vnode) => vnode.type === ChannelAccountStatusBadge,
    );
    expect(badge).toBeTruthy();
    expect(badge.props.status).toBe("paired");
  });

  it("keeps the empty state as Loading... only while the accounts fetch is pending", () => {
    useCachedFetch.mockReturnValue({
      data: null,
      loading: true,
      refresh: vi.fn(),
    });
    let tree = renderChannels();
    let card = collectNodes(tree).find((vnode) => vnode.type === ChannelsCard);
    expect(card.props.items).toHaveLength(0);
    expect(card.props.loadingLabel).toBe("Loading...");

    harness.reset();
    useCachedFetch.mockReturnValue({
      data: { channels: [] },
      loading: false,
      refresh: vi.fn(),
    });
    tree = renderChannels();
    card = collectNodes(tree).find((vnode) => vnode.type === ChannelsCard);
    expect(card.props.items).toHaveLength(0);
    expect(card.props.loadingLabel).toBe("No channels configured");
  });

  it("surfaces a post-mutation refresh failure inline instead of swallowing it", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("offline"));
    useCachedFetch.mockReturnValue({
      data: kTelegramAccountsPayload,
      loading: false,
      refresh,
    });

    renderChannels();
    harness.slots[kDeletingAccountSlot] = {
      id: "default",
      provider: "telegram",
      name: "Telegram",
    };
    let tree = renderChannels();
    const dialog = collectNodes(tree).find(
      (vnode) =>
        vnode.type === ConfirmDialog && vnode.props?.title === "Delete channel?",
    );
    expect(dialog).toBeTruthy();

    await dialog.props.onConfirm();
    await flushAsync();

    expect(api.deleteChannelAccount).toHaveBeenCalledWith({
      provider: "telegram",
      accountId: "default",
    });
    tree = renderChannels();
    const chip = collectNodes(tree).find(
      (vnode) => vnode.type === InlineErrorChip,
    );
    expect(chip).toBeTruthy();
    expect(chip.props.headline).toBe(
      "Saved, but the list could not refresh — reload to see changes.",
    );

    // Retrying from the chip clears the note once the refresh succeeds.
    refresh.mockResolvedValue(kTelegramAccountsPayload);
    await chip.props.onRetry();
    tree = renderChannels();
    expect(
      collectNodes(tree).find((vnode) => vnode.type === InlineErrorChip),
    ).toBeUndefined();
  });

  // D3/D5/D7: DELETE /api/channels/accounts rides `pairingRowsCleanupFailed`,
  // `pairingRowsCleanupDeferred` and `gatewayRestartFailed` beside ok:true.
  // AGENTS.md: a failed pairing-row clear is reported, never a clean delete.
  const confirmDelete = async () => {
    renderChannels();
    harness.slots[kDeletingAccountSlot] = {
      id: "default",
      provider: "telegram",
      name: "Telegram",
    };
    const tree = renderChannels();
    const dialog = collectNodes(tree).find(
      (vnode) =>
        vnode.type === ConfirmDialog && vnode.props?.title === "Delete channel?",
    );
    await dialog.props.onConfirm();
    await flushAsync();
  };

  it("a delete whose pairing-row clear FAILED toasts an error naming the reason and the remedy — never 'Channel deleted' success", async () => {
    api.deleteChannelAccount.mockResolvedValue({
      ok: true,
      pairingRowsCleanupFailed: true,
      pairingRowsCleanupError: "no such table: channel_pairings",
    });
    await confirmDelete();

    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, level] = showToast.mock.calls[0];
    expect(level).toBe("error");
    expect(message).toContain("STILL authorized");
    expect(message).toContain("no such table: channel_pairings");
    expect(message).toContain("Re-add the account and delete it again");
    expect(showToast).not.toHaveBeenCalledWith("Channel deleted", "success");
    // The delete itself succeeded: the dialog closes and the list reloads.
    expect(harness.slots[kDeletingAccountSlot]).toBeNull();
  });

  it("a delete whose pairing-row clear was DEFERRED past a backup barrier toasts a warning (authorized until the backup finishes)", async () => {
    api.deleteChannelAccount.mockResolvedValue({ ok: true, pairingRowsCleanupDeferred: true });
    await confirmDelete();

    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, level] = showToast.mock.calls[0];
    expect(level).toBe("warning");
    expect(message).toContain("stay authorized until the running backup finishes");
  });

  it("gatewayRestartFailed on a delete raises the restart-required banner and says so in the toast", async () => {
    const originalWindow = globalThis.window;
    globalThis.window = { dispatchEvent: vi.fn() };
    try {
      api.deleteChannelAccount.mockResolvedValue({ ok: true, gatewayRestartFailed: true });
      await confirmDelete();

      expect(globalThis.window.dispatchEvent).toHaveBeenCalledTimes(1);
      expect(globalThis.window.dispatchEvent.mock.calls[0][0].type).toBe(
        "alphaclaw:restart-required",
      );
      const [message, level] = showToast.mock.calls[0];
      expect(level).toBe("warning");
      expect(message).toContain("gateway restart also failed");

      // A clean delete never raises the banner.
      globalThis.window.dispatchEvent.mockClear();
      showToast.mockClear();
      api.deleteChannelAccount.mockResolvedValue({ ok: true });
      await confirmDelete();
      expect(globalThis.window.dispatchEvent).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith("Channel deleted", "success");
    } finally {
      globalThis.window = originalWindow;
    }
  });

});
