import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = { values: [], index: 0, effects: [] };
vi.mock("preact/hooks", () => ({
  useState: (initial) => {
    const key = hooks.index++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[key], (next) => (hooks.values[key] = typeof next === "function" ? next(hooks.values[key]) : next)];
  },
  useRef: (value = null) => ({ current: value }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: (effect) => hooks.effects.push(effect),
  useLayoutEffect: () => {},
}));

const kRefresh = vi.fn();
vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: vi.fn(() => ({ data: kData, error: null, refresh: kRefresh })),
}));
vi.mock("../../lib/public/js/lib/api.js", () => ({
  setTelegramGroupPolicy: vi.fn(async (_groupId, body) => (body.dryRun ? { revision: "rev-at-preview", preview: { before: null, after: null }, warnings: [] } : { changed: true })),
  setTelegramBlockedSenders: vi.fn(async () => ({ ok: true })),
  fetchTelegramGroups: vi.fn(),
}));
vi.mock("../../lib/public/js/components/toast.js", () => ({ showToast: vi.fn() }));

import { setTelegramGroupPolicy } from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { GroupsTab } from "../../lib/public/js/components/groups-tab/index.js";
import { BlockedPeople } from "../../lib/public/js/components/groups-tab/blocked-people.js";
import { ModeChangeDialog } from "../../lib/public/js/components/groups-tab/mode-change-dialog.js";

// GST-1975 PR 2b review notes: two races on the Groups page. Every id is fake.
const kData = {
  ok: true,
  configured: true,
  accountId: "default",
  owners: ["100000001"],
  accountPolicy: "allowlist",
  visibleReplies: "automatic",
  blockedSenders: [{ id: "100000007", label: "Spam bot" }],
  groupGuard: { enforced: true, reason: null },
  groups: [],
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  collectNodes(node.props?.children, out);
  return out;
};

beforeEach(() => {
  hooks.values = [];
  hooks.effects = [];
  vi.clearAllMocks();
});

describe("groups page races", () => {
  it("reloads the block list past any poll already in flight after an unblock", async () => {
    hooks.index = 0;
    const blocked = collectNodes(GroupsTab({ accountId: "default" })).find((node) => node.type === BlockedPeople);
    await blocked.props.onChanged();
    expect(kRefresh).toHaveBeenCalledWith({ force: true });
  });

  it("saves the exact body the preview was checked with, under the preview's revision", async () => {
    const group = { groupId: "-1001111111111", title: "Placeholder group", mode: "approved", revision: "rev-old", trusted: [{ id: "300000001", scope: "conversation" }] };
    const render = (props) => {
      hooks.index = 0;
      return ModeChangeDialog({ mode: "approved", accountId: "default", onClose: () => {}, onSaved: () => {}, ...props });
    };
    render({ group });
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(setTelegramGroupPolicy).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const refreshed = { ...group, revision: "rev-new", trusted: [...group.trusted, { id: "300000002", scope: "actions" }] };
    const dialog = render({ group: refreshed });
    await dialog.props.onConfirm();
    const [, body, options] = setTelegramGroupPolicy.mock.calls[1];
    expect(body).toEqual({ mode: "approved", trusted: [{ id: "300000001", scope: "conversation" }], title: "Placeholder group" });
    expect(options).toEqual({ revision: "rev-at-preview", accountId: "default" });
  });

  it("refreshes the page and closes the dialog when the group changed after the preview", async () => {
    const group = { groupId: "-1001111111111", title: "Placeholder group", mode: "silent", revision: "rev-old", trusted: [] };
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const render = () => {
      hooks.index = 0;
      return ModeChangeDialog({ group, mode: "approved", accountId: "default", onClose, onSaved });
    };
    render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(setTelegramGroupPolicy).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    setTelegramGroupPolicy.mockRejectedValueOnce(Object.assign(new Error("changed"), { problem: { code: "revision_mismatch", revision: "rev-new" } }));
    await render().props.onConfirm();
    expect(onSaved).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Someone changed this group"), "error");
  });
});
