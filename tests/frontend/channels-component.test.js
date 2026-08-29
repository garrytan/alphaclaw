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
import * as preactHooks from "preact/hooks";

const harness = preactHooks.__harness;

// useState call order in Channels (see component source; useCachedFetch and
// usePolling are module-mocked so they consume no slots).
const kDeletingAccountSlot = 4;
const kListRefreshErrorSlot = 15;

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
    expect(harness.slots[kListRefreshErrorSlot]).toBeInstanceOf(Error);

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
    expect(harness.slots[kListRefreshErrorSlot]).toBe(null);
    tree = renderChannels();
    expect(
      collectNodes(tree).find((vnode) => vnode.type === InlineErrorChip),
    ).toBeUndefined();
  });
});
