import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadHost, deferred } from "./mounted-read-helpers.js";
import { clearApiCache, getCached, invalidateCache, setCached } from "../../lib/public/js/lib/api-cache.js";
import { authFetch } from "../../lib/public/js/lib/api.js";
import { fetchBackupPreflight, kBackupPreflightCacheKey, useBackupPreflight } from "../../lib/public/js/components/upgrade-tab/use-backup-preflight.js";
import { AbsoluteSymlinkList, BackupPreflightDetails, BackupPreflightDialog } from "../../lib/public/js/components/upgrade-tab/backup-preflight-card.js";

vi.mock("../../lib/public/js/lib/api.js", () => ({ authFetch: vi.fn() }));

const result = (overrides = {}) => ({ ok: true, blocked: false, reason: null, diagnosis: { directories: {
  complete: true, entries: 407321, bytes: 12884901888, rootSymlink: true, stateDir: "/fixture/real-state",
  absoluteSymlinkCount: 2, absoluteSymlinks: [{ path: ".env", target: "/fixture/.env" }, { path: "wiki/index", target: "/fixture/notes" }],
  topLevel: [{ path: "worktrees", entries: 152243, bytes: 6227702579 }, { path: "workspace", entries: 210000, bytes: 3758096384 }],
  topEntries: [{ path: "workspace/.openclaw", entries: 210000, bytes: 3758096384 }],
  topBytes: [{ path: "worktrees", entries: 152243, bytes: 6227702579 }],
  selection: { assetCount: 45078, assetBytes: 1048576, excludedFiles: 362243, excludedBytes: 9985798963 },
} }, ...overrides });
const response = (body = result(), status = 200) => new Response(JSON.stringify(body), { status });
const text = (node) => {
  if (node == null) return "";
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (typeof node !== "object") return String(node);
  if (node.type === AbsoluteSymlinkList) return "";
  if (typeof node.type === "function") return text(node.type(node.props));
  return text(node.props?.children);
};

describe("backup preflight review gate", () => {
  let host;
  const mount = async () => { await host.render([{ id: "preflight", useRead: useBackupPreflight, args: [] }]); await host.settle(); };
  const model = () => host.result("preflight");
  beforeEach(() => {
    vi.clearAllMocks(); clearApiCache(); host = createReadHost();
    vi.stubGlobal("document", host.document);
    authFetch.mockResolvedValue(response());
  });
  afterEach(async () => { await host.unmount(); clearApiCache(); vi.unstubAllGlobals(); });

  it("does not scan on mount and requires fresh successful diagnosis plus explicit confirmation", async () => {
    setCached(kBackupPreflightCacheKey, result());
    await mount();
    expect(authFetch).not.toHaveBeenCalled();
    const action = vi.fn();
    const scan = deferred(); authFetch.mockReturnValueOnce(scan.promise);
    await host.settle(() => { model().request(action); });
    expect(model()).toMatchObject({ dialogOpen: true, checking: true, ready: false });
    await model().confirm();
    expect(action).not.toHaveBeenCalled();
    await host.settle(() => scan.resolve(response()));
    expect(model()).toMatchObject({ checking: false, ready: true });
    expect(action).not.toHaveBeenCalled();
    await host.settle(() => model().confirm());
    await model().confirm();
    expect(action).toHaveBeenCalledTimes(1);
    expect(authFetch).toHaveBeenCalledWith(kBackupPreflightCacheKey, expect.objectContaining({ readTimeoutMs: 120000, signal: expect.any(AbortSignal) }));
  });

  it("blocked and failed checks cannot mutate; retry replaces the error and enables confirmation", async () => {
    await mount(); const action = vi.fn();
    authFetch.mockResolvedValueOnce(response(result({ blocked: true, reason: "Selected state exceeds the backup budget." })));
    await host.settle(() => model().request(action));
    await model().confirm(); expect(action).not.toHaveBeenCalled();
    expect(model().ready).toBe(false);
    authFetch.mockResolvedValueOnce(response({ ok: false, message: "Source scan failed", hint: "Retry" }, 503));
    await host.settle(() => model().refresh());
    expect(model().error.message).toBe("Source scan failed");
    await model().confirm(); expect(action).not.toHaveBeenCalled();
    authFetch.mockResolvedValueOnce(response());
    await host.settle(() => model().refresh());
    expect(model().error).toBeNull();
    await host.settle(() => model().confirm()); expect(action).toHaveBeenCalledOnce();
  });

  it("manual database snapshots require a fresh count and size plus an explicit confirmation", async () => {
    await mount();
    const action = vi.fn();
    await host.settle(() => model().request(action, { recoveryMode: "database_set" }));
    await model().confirm();
    expect(action).not.toHaveBeenCalled();
    expect(BackupPreflightDialog({ model: model() }).props.confirmDisabled).toBe(true);
    authFetch.mockResolvedValueOnce(response({ ok: true, blocked: false, profile: "config_only", checkpoint: { bytes: 2048, fileCount: 4, maxBytes: 16777216 }, databaseCount: 3, databaseBytes: 8 * 1024 ** 3 }));
    await host.settle(() => model().refresh());
    const dialog = BackupPreflightDialog({ model: model() });
    expect(dialog.props.title).toBe("Create database snapshot?");
    expect(dialog.props.confirmDisabled).toBe(false);
    expect(text(dialog.props.details).replace(/\s+/g, " ")).toContain("3 databases");
    expect(text(dialog.props.details)).toContain("8.00 GB");
    expect(action).not.toHaveBeenCalled();
    await host.settle(() => model().confirm());
    expect(action).toHaveBeenCalledOnce();
    expect(model().recoveryMode).toBe("config_only");
  });

  it("cancel and invalidation fence the pending action even after a successful scan", async () => {
    await mount(); const action = vi.fn();
    await host.settle(() => model().request(action));
    await host.settle(() => invalidateCache(kBackupPreflightCacheKey));
    await model().confirm(); expect(action).not.toHaveBeenCalled();
    authFetch.mockResolvedValueOnce(response());
    await host.settle(() => model().refresh());
    await host.settle(() => model().cancel());
    await model().confirm(); expect(action).not.toHaveBeenCalled();
  });

  it("does not revive a cancelled action when its scan finishes", async () => {
    await mount(); const action = vi.fn(); const scan = deferred();
    authFetch.mockReturnValueOnce(scan.promise);
    await host.settle(() => { model().request(action); });
    await host.settle(() => model().cancel());
    await host.settle(() => scan.resolve(response()));
    expect(model().dialogOpen).toBe(false);
    await model().confirm(); expect(action).not.toHaveBeenCalled();
    await host.unmount();
    expect(getCached(kBackupPreflightCacheKey)).toMatchObject({ blocked: false });
  });

  it("renders absolute symlink targets only on expansion and limits the first page to 100", async () => {
    const directories = { absoluteSymlinkCount: 10001, absoluteSymlinks: Array.from({ length: 10001 }, (_, index) => ({ path: `wiki/${index}`, target: `/outside/${index}` })) };
    await host.render([{ id: "links", useRead: AbsoluteSymlinkList, args: [{ directories }] }]);
    expect(text(host.result("links"))).toContain("10,001");
    expect(text(host.result("links"))).not.toContain("/outside/");
    await host.settle(() => host.result("links").props.onToggle({ currentTarget: { open: true } }));
    expect(text(host.result("links")).replace(/\s+/g, " ")).toContain("wiki/99 → /outside/99");
    expect(text(host.result("links"))).not.toContain("wiki/100");
    expect(text(host.result("links")).replace(/\s+/g, " ")).toContain("9,901 remaining");
  });
});

describe("backup preflight presentation and API", () => {
  it("accepts bounded configuration without a broad diagnostic and shows omitted database data", async () => {
    const data = { ok: true, profile: "config_only", blocked: false, checkpoint: { bytes: 2048, fileCount: 3, maxBytes: 16777216 }, databaseCount: 2, databaseBytes: 20 * 1024 ** 3, coverage: { config: "complete", databases: "omitted" } };
    authFetch.mockResolvedValueOnce(response(data));
    expect(await fetchBackupPreflight()).toEqual(data);
    const output = text(BackupPreflightDetails({ model: { data } }));
    expect(output).toContain("Configuration checkpoint; database data not backed up");
    expect(output).toContain("16 MiB");
    expect(output).toContain("Database data omitted");
    expect(output).not.toContain("Every top-level path");
    for (const checkpoint of [{ ...data.checkpoint, bytes: 16777217 }, { ...data.checkpoint, maxBytes: 1024 ** 3 }, { ...data.checkpoint, fileCount: -1 }]) {
      authFetch.mockResolvedValueOnce(response({ ...data, checkpoint }));
      await expect(fetchBackupPreflight()).rejects.toThrow("invalid backup preflight");
    }
  });
  it("renders full counts, top-level paths, both rankings, symlink list and blocked reason", () => {
    const output = text(BackupPreflightDetails({ model: { data: result({ blocked: true, reason: "Selected state exceeds the backup budget." }) } }));
    for (const fragment of ["407,321", "152,243", "210,000", "12.0 GB", "Every top-level path", "Most entries", "Most bytes", "workspace/.openclaw", "a symlink", "before gateway pause", "exceeds the backup budget"]) expect(output).toContain(fragment);
  });
  it("keeps Continue disabled for loading, error, blocked, and unverified states", () => {
    for (const overrides of [{ ready: false }, { checking: true }, { error: new Error("Failed") }, { data: result({ blocked: true }) }]) {
      const dialog = BackupPreflightDialog({ model: { dialogOpen: true, ready: true, data: result(), ...overrides } });
      expect(dialog.props.confirmDisabled).toBe(true);
    }
  });
  it("rejects malformed preflight payloads and preserves actionable error hints", async () => {
    authFetch.mockResolvedValueOnce(response({ ok: true, diagnosis: {} }));
    await expect(fetchBackupPreflight()).rejects.toThrow("invalid backup preflight");
    authFetch.mockResolvedValueOnce(response({ ok: false, code: "config_unreadable", message: "Cannot read settings", hint: "Restore settings" }, 503));
    await expect(fetchBackupPreflight()).rejects.toMatchObject({ code: "config_unreadable", status: 503, hint: "Restore settings" });
  });
});
