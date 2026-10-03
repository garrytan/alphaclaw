import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useRef: (v = null) => ({ current: v }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: () => {},
}));

const cachedRead = { data: null, error: null, refresh: vi.fn() };
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: vi.fn(() => cachedRead),
}));
vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: vi.fn(() => ({ data: null, error: null, refresh: vi.fn() })),
}));
vi.mock("../../lib/public/js/lib/api.js", () => ({
  createOpenclawBackup: vi.fn(),
  fetchOpenclawBackupStatus: vi.fn(),
}));

import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { usePolling } from "../../lib/public/js/hooks/usePolling.js";
import {
  createOpenclawBackup,
  fetchOpenclawBackupStatus,
} from "../../lib/public/js/lib/api.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import {
  BackupsCard,
  buildBackupResultModel,
} from "../../lib/public/js/components/general/backups-card.js";

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  if (typeof node.type === "function" && node.type !== ActionButton) {
    return expandTree(node.type(node.props || {}));
  }
  const children = node.props?.children;
  if (children === undefined) return node;
  return { ...node, props: { ...node.props, children: expandTree(children) } };
};

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (Array.isArray(node)) node.forEach((child) => collectText(child, out));
  else if (node?.props) collectText(node.props.children, out);
  return out;
};

const findButton = (node) => {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) return found;
    }
    return null;
  }
  if (node.type === ActionButton) return node;
  return findButton(node.props?.children);
};

const render = (data) => {
  cachedRead.data = data;
  const tree = expandTree(BackupsCard({ isActive: true }));
  return {
    tree,
    text: collectText(tree).join(" ").replace(/\s+/g, " "),
    button: findButton(tree),
  };
};

describe("frontend/general backups card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cachedRead.data = null;
    cachedRead.error = null;
    cachedRead.refresh = vi.fn(async () => null);
  });

  it("builds the last-result view model for success, failure, and no result", () => {
    expect(buildBackupResultModel(null)).toBe(null);
    const success = buildBackupResultModel({
      ok: true,
      startedAt: 1,
      finishedAt: 2,
      archivePath: "/data/backups/openclaw-1.tar.gz",
      bytes: 2048,
      error: null,
    });
    expect(success).toMatchObject({
      ok: true,
      archivePath: "/data/backups/openclaw-1.tar.gz",
      size: "2.00 KB",
    });
    expect(buildBackupResultModel({ ok: false, finishedAt: 2, error: "disk full" })).toMatchObject({
      ok: false,
      error: "disk full",
    });
    expect(buildBackupResultModel({ ok: false }).error).toBe("Backup failed.");
  });

  it("reads GET /api/openclaw/backup and polls only while a backup is running", () => {
    render({ ok: true, running: false, last: null });
    expect(useCachedFetch).toHaveBeenCalledWith(
      "/api/openclaw/backup",
      fetchOpenclawBackupStatus,
      expect.objectContaining({ enabled: true }),
    );
    expect(usePolling).toHaveBeenLastCalledWith(
      fetchOpenclawBackupStatus,
      3000,
      expect.objectContaining({ enabled: false, cacheKey: "/api/openclaw/backup" }),
    );

    const { button } = render({ ok: true, running: true, last: null });
    expect(usePolling).toHaveBeenLastCalledWith(
      fetchOpenclawBackupStatus,
      3000,
      expect.objectContaining({ enabled: true }),
    );
    expect(button.props.loading).toBe(true);
  });

  it("shows the help sentence and the last success with path and size", () => {
    const { text, button } = render({
      ok: true,
      running: false,
      last: { ok: true, startedAt: 1, finishedAt: 2, archivePath: "/b/x.tar.gz", bytes: 1024, error: null },
    });
    expect(text).toContain("Runs OpenClaw's own backup");
    expect(text).toContain("openclaw backup create");
    expect(text).toContain("/b/x.tar.gz");
    expect(text).toContain("1.00 KB");
    expect(button.props.idleLabel).toBe("Back up now");
    expect(button.props.loading).toBe(false);
  });

  it("shows the error text of a failed last backup", () => {
    const { text } = render({
      ok: true,
      running: false,
      last: { ok: false, startedAt: 1, finishedAt: 2, archivePath: null, bytes: null, error: "openclaw exited 1" },
    });
    expect(text).toContain("Last backup failed");
    expect(text).toContain("openclaw exited 1");
  });

  it("Back up now POSTs, then force-refreshes only its own status key", async () => {
    createOpenclawBackup.mockResolvedValue({ ok: true, started: true });
    const { button } = render({ ok: true, running: false, last: null });
    await button.props.onClick();
    expect(createOpenclawBackup).toHaveBeenCalledTimes(1);
    expect(cachedRead.refresh).toHaveBeenCalledWith({ force: true });
  });

  it("a 409 backup_in_progress still refreshes so the running state shows", async () => {
    createOpenclawBackup.mockRejectedValue(
      Object.assign(new Error("already running"), { code: "backup_in_progress", status: 409 }),
    );
    const { button } = render({ ok: true, running: false, last: null });
    await button.props.onClick();
    expect(cachedRead.refresh).toHaveBeenCalledWith({ force: true });
  });
});
