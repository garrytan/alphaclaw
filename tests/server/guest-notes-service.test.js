const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGuestWritesService, receiptState } = require("../../lib/server/guest-writes");
const { normalizeGuestNotesConfig } = require("../../lib/server/guest-writes/config");
const { guestWritesPaths } = require("../../lib/server/guest-writes/constants");
const { startFakeGbrain } = require("./helpers/fake-gbrain-mcp");

const kGroupKey = "telegram:-1001234567890";
const kClaim = {
  run_id: "run-1",
  session_key: "agent:main:telegram:group:-1001234567890",
  parent_run_id: null,
  group_key: kGroupKey,
  audience_member: "groupmember1",
  sender_id: "424242",
  sender_label: "Ada [guest]",
  group_slug: "g0123456789abcdef",
  member_slug: "mfedcba9876543210",
  member_uid: 10101,
  channel: "telegram",
  turn_started_at: "2026-11-14T10:00:00.000Z",
};

// The member's uid is at least 10100, which a test process is not, so the
// file owner check sees the member's uid through this fstat.
const memberOwnedFs = { ...fs, fstatSync: (fd) => Object.assign(Object.create(Object.getPrototypeOf(fs.fstatSync(fd))), fs.fstatSync(fd), { uid: 10101 }) };

const setup = async ({ handlers = {}, config = { groups: { [kGroupKey]: { enabled: true } } }, nowMs = Date.parse("2026-11-14T10:00:00Z"), fsModule = fs } = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "guest-notes-"));
  const taken = new Set();
  const brain = await startFakeGbrain({
    handlers: {
      get_brain_identity: () => ({ version: "0.61.0", capabilities: ["large_pages_v1", "guest_marker_v1"] }),
      put_page: (args) => {
        if (taken.has(args.slug)) throw Object.assign(new Error("exists"), { code: "revision_required" });
        taken.add(args.slug);
        return { request_id: args.request_id, state: "committed", slug: args.slug };
      },
      ...handlers,
    },
  });
  const paths = guestWritesPaths(rootDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.clientFile, JSON.stringify(brain.credential), { mode: 0o600 });
  let current = { guestNotes: normalizeGuestNotesConfig(config) };
  const clock = { now: nowMs };
  const logs = [];
  const service = createGuestWritesService({
    rootDir,
    readConfig: () => current,
    updateConfig: (mutate) => {
      const next = mutate(current) || current;
      current = { ...next, guestNotes: normalizeGuestNotesConfig(next.guestNotes) };
    },
    now: () => clock.now,
    fsModule,
    sleep: async () => {},
    log: (line) => logs.push(line),
  });
  service.start();
  return { rootDir, brain, service, paths, clock, logs, config: () => current };
};

let ctx = null;
afterEach(async () => {
  ctx?.service.stop();
  await ctx?.brain.close();
  if (ctx) fs.rmSync(ctx.rootDir, { recursive: true, force: true });
  ctx = null;
});

const claimRef = (service, overrides = {}) => {
  const result = service.claim({ ...kClaim, ...overrides });
  expect(result.ok).toBe(true);
  return result.claim_ref;
};

describe("guest notes broker", () => {
  it("makes the internal secret 0600 and checks the bearer against it", async () => {
    ctx = await setup();
    const secret = fs.readFileSync(ctx.paths.secretFile, "utf8").trim();
    expect(fs.statSync(ctx.paths.secretFile).mode & 0o777).toBe(0o600);
    expect(ctx.service.isInternalSecret(secret)).toBe(true);
    expect(ctx.service.isInternalSecret(secret.slice(0, -1) + "x")).toBe(false);
    expect(ctx.service.isInternalSecret("")).toBe(false);
  });

  it("refuses a malformed claim, the fallback uid and a bad slug", async () => {
    ctx = await setup();
    expect(ctx.service.claim({ ...kClaim, member_uid: 10097 }).ok).toBe(false);
    expect(ctx.service.claim({ ...kClaim, member_slug: "m-not-hex" }).ok).toBe(false);
    expect(ctx.service.claim({ ...kClaim, group_key: "no colon" }).ok).toBe(false);
    expect(ctx.service.claim({ ...kClaim, audience_member: "" }).ok).toBe(false);
  });

  it("saves a note on behalf of the audience member, with guest metadata and the owner plus member as readers", async () => {
    ctx = await setup();
    const result = await ctx.service.save({ kind: "note", title: "Trip plan", text: "Leave at 9.\r\n", claim_ref: claimRef(ctx.service) });
    expect(result).toMatchObject({ status: "saved", slug: "guests/g0123456789abcdef/mfedcba9876543210/2026-11-14-trip-plan" });
    const put = ctx.brain.calls.find((call) => call.name === "put_page");
    expect(put.headers.onBehalfOf).toBe("member:groupmember1");
    expect(put.headers.agentLabel).toBe("alphaclaw-guest-broker");
    expect(put.headers.authorization).toBe("Bearer tok-1");
    expect(put.meta).toEqual({ guest: { sender_label: "Ada guest", group: "g0123456789abcdef" } });
    expect(put.args).toMatchObject({ source_id: "guests", content_origin: "tool_output" });
    expect(put.args.expected_revision).toBeUndefined();
    expect(put.args.force).toBeUndefined();
    expect(put.args.content).toContain('readable_by: ["member:owner1", "member:groupmember1"]');
    expect(put.args.content).not.toContain("Ada");
    expect(ctx.brain.tokenRequests[0]).toMatchObject({ grant_type: "client_credentials", client_id: "guest-broker" });
    expect(ctx.logs.join("\n")).not.toContain("Leave at 9");
  });

  it("spends the claim on an accepted save, and a repeat of the same save is a duplicate", async () => {
    ctx = await setup();
    const ref = claimRef(ctx.service);
    await ctx.service.save({ kind: "note", title: "Trip plan", text: "Leave at 9.", claim_ref: ref });
    await expect(ctx.service.save({ kind: "note", title: "Trip plan", text: "Leave at 9.", claim_ref: ref })).rejects.toMatchObject({ code: "claim_invalid" });
    const again = await ctx.service.save({ kind: "note", title: "Trip plan", text: "Leave at 9.", claim_ref: claimRef(ctx.service) });
    expect(again.status).toBe("duplicate");
    expect(ctx.brain.calls.filter((call) => call.name === "put_page")).toHaveLength(1);
  });

  it("refuses an expired or unknown claim, an off group and a brain without the guest marker", async () => {
    ctx = await setup();
    const ref = claimRef(ctx.service);
    ctx.clock.now += 11 * 60 * 1000;
    await expect(ctx.service.save({ kind: "note", title: "t", text: "x", claim_ref: ref })).rejects.toMatchObject({ code: "claim_invalid" });
    await expect(ctx.service.save({ kind: "note", title: "t", text: "x", claim_ref: "made-up" })).rejects.toMatchObject({ code: "claim_invalid" });
    await expect(ctx.service.save({ kind: "note", title: "t", text: "x", claim_ref: claimRef(ctx.service, { group_key: "telegram:-1009" }) })).rejects.toMatchObject({ code: "guest_saves_off" });
    ctx.brain.handlers.get_brain_identity = () => ({ capabilities: ["large_pages_v1"] });
    expect((await ctx.service.capability({ fresh: true })).available).toBe(false);
    await expect(ctx.service.save({ kind: "note", title: "t", text: "x", claim_ref: claimRef(ctx.service) })).rejects.toMatchObject({ code: "guest_saves_unavailable" });
    await expect(ctx.service.setGroup({ groupKey: "telegram:-1009", enabled: true })).rejects.toMatchObject({ code: "guest_saves_unavailable" });
    await ctx.service.setGroup({ groupKey: kGroupKey, enabled: false });
    expect(ctx.config().guestNotes.groups[kGroupKey].enabled).toBe(false);
  });

  it("refuses malformed input and an oversize note", async () => {
    ctx = await setup();
    await expect(ctx.service.save({ kind: "note", title: "", text: "x", claim_ref: claimRef(ctx.service) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(ctx.service.save({ kind: "note", title: "t", text: "x", file_path: "/tmp/x", claim_ref: claimRef(ctx.service) })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(ctx.service.save({ kind: "note", title: "t", text: "x".repeat(70000), claim_ref: claimRef(ctx.service) })).rejects.toMatchObject({ code: "guest_note_too_large" });
  });

  it("holds the daily cap per member per group", async () => {
    ctx = await setup({ config: { groups: { [kGroupKey]: { enabled: true, dailyCap: 2 } } } });
    await ctx.service.save({ kind: "note", title: "a", text: "one", claim_ref: claimRef(ctx.service) });
    await ctx.service.save({ kind: "note", title: "b", text: "two", claim_ref: claimRef(ctx.service) });
    await expect(ctx.service.save({ kind: "note", title: "c", text: "three", claim_ref: claimRef(ctx.service) })).rejects.toMatchObject({ code: "guest_cap_reached" });
    const other = await ctx.service.save({ kind: "note", title: "c", text: "three", claim_ref: claimRef(ctx.service, { member_slug: "m1111111111111111", member_uid: 10102 }) });
    expect(other.status).toBe("saved");
  });

  it("moves to the next slug when the slug exists, with a new request id", async () => {
    let first = true;
    ctx = await setup({
      handlers: {
        put_page: (args) => {
          if (first) {
            first = false;
            throw Object.assign(new Error("exists"), { code: "revision_required" });
          }
          return { state: "committed", slug: args.slug };
        },
      },
    });
    const result = await ctx.service.save({ kind: "note", title: "Trip plan", text: "x", claim_ref: claimRef(ctx.service) });
    expect(result.slug.endsWith("-trip-plan-2")).toBe(true);
    const puts = ctx.brain.calls.filter((call) => call.name === "put_page");
    expect(puts).toHaveLength(2);
    expect(puts[0].args.request_id).not.toBe(puts[1].args.request_id);
  });

  it("retries a busy gbrain with the same request id, then answers guest_save_retry and reuses it next time", async () => {
    let busy = true;
    ctx = await setup({
      handlers: {
        put_page: (args) => {
          if (busy) throw Object.assign(new Error("busy"), { code: "lock_busy" });
          return { state: "queued", request_id: args.request_id };
        },
        get_write_request: () => {
          throw Object.assign(new Error("missing"), { code: "not_found" });
        },
      },
    });
    await expect(ctx.service.save({ kind: "note", title: "t", text: "x", claim_ref: claimRef(ctx.service) })).rejects.toMatchObject({ code: "guest_save_retry" });
    const ids = new Set(ctx.brain.calls.filter((call) => call.name === "put_page").map((call) => call.args.request_id));
    expect(ids.size).toBe(1);
    busy = false;
    const result = await ctx.service.save({ kind: "note", title: "t", text: "x", claim_ref: claimRef(ctx.service) });
    expect(result.status).toBe("pending");
    const read = ctx.brain.calls.find((call) => call.name === "get_write_request");
    expect(read.headers.onBehalfOf).toBe("member:groupmember1");
    expect(ctx.brain.calls.filter((call) => call.name === "put_page").at(-1).args.request_id).toBe([...ids][0]);
  });

  it("retention reads and deletes on behalf of the page's member, skips promoted notes and marks a member who left may_act_for orphaned", async () => {
    const promoted = new Set();
    const denied = new Set();
    ctx = await setup({
      handlers: {
        get_page: (args) => {
          if (denied.has(args.slug)) throw Object.assign(new Error("no"), { code: "on_behalf_of_not_allowed" });
          return { slug: args.slug, guest: { promoted: promoted.has(args.slug) } };
        },
        delete_page: (args) => ({ state: "committed", slug: args.slug }),
      },
    });
    const a = await ctx.service.save({ kind: "note", title: "a", text: "one", claim_ref: claimRef(ctx.service) });
    const b = await ctx.service.save({ kind: "note", title: "b", text: "two", claim_ref: claimRef(ctx.service) });
    const c = await ctx.service.save({ kind: "note", title: "c", text: "three", claim_ref: claimRef(ctx.service, { audience_member: "leftmember" }) });
    promoted.add(b.slug);
    denied.add(c.slug);
    ctx.clock.now += 91 * 24 * 60 * 60 * 1000;
    const out = await ctx.service.sweep();
    expect(out).toMatchObject({ deleted: 1, promoted: 1, orphaned: 1 });
    const deletes = ctx.brain.calls.filter((call) => call.name === "delete_page");
    expect(deletes.map((call) => call.args.slug)).toEqual([a.slug]);
    expect(deletes[0].headers.onBehalfOf).toBe("member:groupmember1");
    expect(deletes[0].args.expected_revision).toBeUndefined();
    for (const call of ctx.brain.calls) expect(call.name === "get_brain_identity" || Boolean(call.headers.onBehalfOf)).toBe(true);
    const status = await ctx.service.status();
    expect(status.groups[kGroupKey]).toMatchObject({ orphaned: 1 });
  });

  it("keeps each save's file apart, and removes only a deleted save's own copy after the restore window", async () => {
    const promoted = new Set();
    ctx = await setup({
      fsModule: memberOwnedFs,
      config: { groups: { [kGroupKey]: { enabled: true } } },
      handlers: {
        get_page: (args) => ({ slug: args.slug, guest: { promoted: promoted.has(args.slug) } }),
        delete_page: (args) => ({ state: "committed", slug: args.slug }),
      },
    });
    const scratchRoot = path.join(ctx.rootDir, "scratch");
    const scratch = path.join(scratchRoot, kClaim.member_slug, "tmp");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "plan.txt"), "same bytes");
    ctx.config().guestNotes.scratchRoot = scratchRoot;
    const first = await ctx.service.save({ kind: "file", title: "plan", file_path: path.join(scratch, "plan.txt"), claim_ref: claimRef(ctx.service, { run_id: "run-a" }) });
    const second = await ctx.service.save({ kind: "file", title: "plan", file_path: path.join(scratch, "plan.txt"), claim_ref: claimRef(ctx.service, { run_id: "run-b" }) });
    const kept = () => fs.readdirSync(path.join(ctx.paths.filesDir, kClaim.group_slug, kClaim.member_slug)).sort();
    expect(kept()).toHaveLength(2);
    promoted.add(second.slug);
    ctx.clock.now += 91 * 24 * 60 * 60 * 1000;
    expect(await ctx.service.sweep()).toMatchObject({ deleted: 1, promoted: 1 });
    ctx.clock.now += 73 * 60 * 60 * 1000;
    expect(await ctx.service.sweep()).toMatchObject({ filesRemoved: 1 });
    expect(kept()).toHaveLength(1);
    expect(first.slug).not.toBe(second.slug);
  });

  it("releases a refused save's file, and counts refused saves toward the daily cap", async () => {
    ctx = await setup({
      fsModule: memberOwnedFs,
      config: { groups: { [kGroupKey]: { enabled: true, dailyCap: 2 } } },
      handlers: {
        put_page: () => {
          throw Object.assign(new Error("no"), { code: "guest_attribution_missing" });
        },
      },
    });
    const scratchRoot = path.join(ctx.rootDir, "scratch");
    const scratch = path.join(scratchRoot, kClaim.member_slug, "tmp");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "big.bin"), Buffer.alloc(4096));
    ctx.config().guestNotes.scratchRoot = scratchRoot;
    const fileSave = (run) => ctx.service.save({ kind: "file", title: "big", file_path: path.join(scratch, "big.bin"), claim_ref: claimRef(ctx.service, { run_id: run }) });
    await expect(fileSave("r1")).rejects.toMatchObject({ code: "guest_save_failed" });
    await expect(fileSave("r2")).rejects.toMatchObject({ code: "guest_save_failed" });
    await expect(fileSave("r3")).rejects.toMatchObject({ code: "guest_cap_reached" });
    const dir = path.join(ctx.paths.filesDir, kClaim.group_slug, kClaim.member_slug);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it("marks an expired note deleted only when gbrain confirms the delete, and never reads a denial as not found", async () => {
    let deleteAnswer = () => ({ state: "failed", write_error: "write_failed" });
    ctx = await setup({
      handlers: {
        get_page: (args) => ({ slug: args.slug, guest: {} }),
        delete_page: () => deleteAnswer(),
      },
    });
    await ctx.service.save({ kind: "note", title: "a", text: "one", claim_ref: claimRef(ctx.service) });
    ctx.clock.now += 91 * 24 * 60 * 60 * 1000;
    expect(await ctx.service.sweep()).toMatchObject({ deleted: 0 });
    deleteAnswer = () => {
      throw Object.assign(new Error("scope"), { code: "scope_missing" });
    };
    expect(await ctx.service.sweep()).toMatchObject({ deleted: 0 });
    deleteAnswer = () => ({ state: "queued" });
    expect(await ctx.service.sweep()).toMatchObject({ deleted: 0 });
    deleteAnswer = () => ({ state: "committed" });
    expect(await ctx.service.sweep()).toMatchObject({ deleted: 1 });
  });

  it("settles a retry row that gbrain never accepted, and frees its live slot", async () => {
    ctx = await setup({
      config: { groups: { [kGroupKey]: { enabled: true, liveCap: 1 } } },
      handlers: {
        put_page: () => {
          throw Object.assign(new Error("busy"), { code: "lock_busy" });
        },
        get_write_request: () => {
          throw Object.assign(new Error("missing"), { code: "not_found" });
        },
      },
    });
    await expect(ctx.service.save({ kind: "note", title: "a", text: "one", claim_ref: claimRef(ctx.service) })).rejects.toMatchObject({ code: "guest_save_retry" });
    ctx.clock.now += 25 * 60 * 60 * 1000;
    expect(await ctx.service.sweep()).toMatchObject({ settled: 1 });
    ctx.brain.handlers.put_page = (args) => ({ state: "committed", slug: args.slug });
    expect((await ctx.service.save({ kind: "note", title: "b", text: "two", claim_ref: claimRef(ctx.service) })).status).toBe("saved");
  });

  it("sends a queued save again under the next slug when gbrain later reports a slug conflict, and keeps no page once it settles", async () => {
    const receipts = {};
    ctx = await setup({
      handlers: {
        put_page: (args) => {
          if (args.slug.endsWith("-2")) return { request_id: args.request_id, state: "committed", slug: args.slug };
          receipts[args.request_id] = { request_id: args.request_id, state: "conflict" };
          return { request_id: args.request_id, state: "queued" };
        },
        get_write_request: (args) => receipts[args.request_id],
      },
    });
    const first = await ctx.service.save({ kind: "note", title: "standup", text: "ship it", claim_ref: claimRef(ctx.service) });
    expect(first.status).toBe("pending");
    const { openGuestStore } = require("../../lib/server/guest-writes/store");
    const peek = () => {
      const store = openGuestStore({ dbPath: ctx.paths.dbFile });
      const row = store.getSave(store.listUnsettled()[0]?.idemKey || "") || null;
      store.close();
      return row;
    };
    expect(peek().page).toMatchObject({ title: "standup", body: "ship it" });
    expect(await ctx.service.sweep()).toMatchObject({ settled: 1 });
    const puts = ctx.brain.calls.filter((call) => call.name === "put_page");
    expect(puts).toHaveLength(2);
    expect(puts[1].args.slug).toBe(puts[0].args.slug + "-2");
    expect(puts[1].args.content).toContain("ship it");
    expect(peek()).toBeNull();
    const store = openGuestStore({ dbPath: ctx.paths.dbFile });
    expect(store.getSaveBySlug(puts[1].args.slug)).toMatchObject({ state: "saved", page: null });
    store.close();
  });

  it("answers guest_save_retry to the same save while the first is still in flight, then a repeat is a duplicate", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    ctx = await setup({
      handlers: {
        put_page: async (args) => {
          await gate;
          return { request_id: args.request_id, state: "committed", slug: args.slug };
        },
      },
    });
    const note = { kind: "note", title: "standup", text: "ship it" };
    const first = ctx.service.save({ ...note, claim_ref: claimRef(ctx.service) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(ctx.service.save({ ...note, claim_ref: claimRef(ctx.service) })).rejects.toMatchObject({ code: "guest_save_retry" });
    release();
    expect((await first).status).toBe("saved");
    expect((await ctx.service.save({ ...note, claim_ref: claimRef(ctx.service) })).status).toBe("duplicate");
    expect(ctx.brain.calls.filter((call) => call.name === "put_page")).toHaveLength(1);
  });

  it("tells a repeat save the truth when gbrain failed the queued write, instead of calling it already saved", async () => {
    const receipts = {};
    ctx = await setup({
      handlers: {
        put_page: (args) => {
          receipts[args.request_id] = { request_id: args.request_id, state: "failed", write_error: "storage_full" };
          return { request_id: args.request_id, state: "queued" };
        },
        get_write_request: (args) => receipts[args.request_id],
      },
    });
    const note = { kind: "note", title: "standup", text: "ship it" };
    expect((await ctx.service.save({ ...note, claim_ref: claimRef(ctx.service) })).status).toBe("pending");
    await expect(ctx.service.save({ ...note, claim_ref: claimRef(ctx.service) })).rejects.toMatchObject({ code: "guest_save_failed" });
    const { openGuestStore } = require("../../lib/server/guest-writes/store");
    const store = openGuestStore({ dbPath: ctx.paths.dbFile });
    expect(store.listUnsettled()).toEqual([]);
    store.close();
  });

  it("refuses an oversized note before normalizing it", async () => {
    ctx = await setup();
    const started = Date.now();
    await expect(ctx.service.save({ kind: "note", title: "big", text: "a" + " ".repeat(300000) + "b", claim_ref: claimRef(ctx.service) })).rejects.toMatchObject({ code: "guest_note_too_large" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("maps gbrain receipt states", () => {
    expect(receiptState({ state: "committed" })).toBe("saved");
    expect(receiptState({ state: "queued" })).toBe("pending");
    expect(receiptState({ state: "conflict" })).toBe("revision");
    expect(receiptState({ state: "failed" })).toBe("failed");
  });
});
