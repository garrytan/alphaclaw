const fs = require("fs");
const os = require("os");
const path = require("path");
const { applyGuestNotesMcpEntry, resolveDesiredGuestNotesMcpEntry, kStdioScript } = require("../../lib/server/guest-writes/mcp-entry");
const { createGuestSaveCaller, kGuestSaveTool } = require("../../lib/server/guest-writes/mcp-stdio");
const { guestWritesPaths } = require("../../lib/server/guest-writes/constants");
const { runGuestNotesCommand } = require("../../lib/cli/guest-notes");
const { openGuestStore } = require("../../lib/server/guest-writes/store");

let rootDir;
beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "guest-mcp-"));
});
afterEach(() => fs.rmSync(rootDir, { recursive: true, force: true }));

describe("guest_notes MCP entry", () => {
  it("is present only while the broker credential exists, and never touches an entry it does not own", () => {
    expect(resolveDesiredGuestNotesMcpEntry({ rootDir, appPort: 3000 })).toBeNull();
    const paths = guestWritesPaths(rootDir);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.clientFile, "{}");
    const desired = resolveDesiredGuestNotesMcpEntry({ rootDir, appPort: 3000 });
    expect(desired.args).toEqual([kStdioScript, "--root-dir", rootDir, "--app-port", "3000"]);
    expect(JSON.stringify(desired)).not.toMatch(/secret/i);

    const cfg = {};
    expect(applyGuestNotesMcpEntry(cfg, desired, { log: () => {} })).toEqual({ changed: true, conflict: false });
    expect(applyGuestNotesMcpEntry(cfg, desired, { log: () => {} })).toEqual({ changed: false, conflict: false });
    expect(applyGuestNotesMcpEntry(cfg, null, { log: () => {} })).toEqual({ changed: true, conflict: false });
    expect(cfg.mcp.servers.guest_notes).toBeUndefined();

    const foreign = { mcp: { servers: { guest_notes: { command: "other" } } } };
    expect(applyGuestNotesMcpEntry(foreign, desired, { log: () => {} })).toEqual({ changed: false, conflict: true });
    expect(applyGuestNotesMcpEntry(foreign, null, { log: () => {} })).toEqual({ changed: false, conflict: false });
    expect(foreign.mcp.servers.guest_notes).toEqual({ command: "other" });
  });
});

describe("guest_save tool", () => {
  it("posts to AlphaClaw's loopback save route with the internal secret and passes the guard's claim_ref", async () => {
    const paths = guestWritesPaths(rootDir);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.secretFile, "s".repeat(64));
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ ok: true, status: "saved", slug: "guests/x", say: "Saved as a guest note." }) }));
    const call = createGuestSaveCaller({ rootDir, appPort: 4321, fetchImpl });
    const result = await call({ kind: "note", title: "t", text: "x", claim_ref: "ref-1", extra: "dropped" });
    expect(result).toMatchObject({ isError: false, structuredContent: { status: "saved", slug: "guests/x" } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4321/internal/guest-writes/save");
    expect(init.headers.authorization).toBe("Bearer " + "s".repeat(64));
    expect(JSON.parse(init.body)).toEqual({ kind: "note", title: "t", text: "x", claim_ref: "ref-1" });
  });

  it("answers a refusal with the code, what the room hears and the fix, and nothing else", async () => {
    const call = createGuestSaveCaller({ rootDir, appPort: 1, fetchImpl: async () => ({ json: async () => ({ ok: false, code: "guest_saves_off" }) }) });
    expect(await call({})).toMatchObject({ isError: true, structuredContent: { code: "guest_saves_unavailable" } });
    const paths = guestWritesPaths(rootDir);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.secretFile, "s".repeat(64));
    const refused = await call({});
    expect(refused.structuredContent).toEqual({ code: "guest_saves_off", what: "Saving guest notes is off in this group.", fix: "The owner can turn it on in the Groups page." });
    expect(kGuestSaveTool.inputSchema.additionalProperties).toBe(false);
  });
});

describe("alphaclaw guest-notes sweep", () => {
  it("lists orphaned notes, and with --apply deletes each through the gbrain CLI and marks it deleted", async () => {
    const paths = guestWritesPaths(rootDir);
    const store = openGuestStore({ dbPath: paths.dbFile });
    const base = { requestId: "r", attempt: 1, kind: "note", title: "t", groupKey: "telegram:-1", groupSlug: "g0123456789abcdef", memberSlug: "m0123456789abcdef", audienceMember: "gone", day: "2026-11-14" };
    store.insertSave({ ...base, idemKey: "k1", slug: "guests/g0123456789abcdef/m0123456789abcdef/2026-11-14-a", state: "orphaned" });
    store.insertSave({ ...base, idemKey: "k2", slug: "guests/g0123456789abcdef/m0123456789abcdef/2026-11-14-b", state: "saved" });
    store.close();
    const out = [];
    expect(await runGuestNotesCommand({ argv: ["sweep"], rootDir, json: true, write: (t) => out.push(t), runner: vi.fn() })).toBe(0);
    expect(JSON.parse(out[0]).orphaned).toEqual(["guests/g0123456789abcdef/m0123456789abcdef/2026-11-14-a"]);
    const runner = vi.fn(async () => ({ exitCode: 0, json: {} }));
    expect(await runGuestNotesCommand({ argv: ["sweep", "--apply"], rootDir, json: true, write: (t) => out.push(t), runner })).toBe(0);
    expect(runner).toHaveBeenCalledWith(["delete", "--source", "guests", "--json", "--", "guests/g0123456789abcdef/m0123456789abcdef/2026-11-14-a"]);
    const after = openGuestStore({ dbPath: paths.dbFile });
    expect(after.getSave("k1").state).toBe("deleted");
    expect(after.getSave("k2").state).toBe("saved");
    after.close();
  });
});
