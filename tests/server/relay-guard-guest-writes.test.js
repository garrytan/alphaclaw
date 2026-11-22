const fs = require("fs");
const path = require("path");
const { setup, expectProgramsRefused } = require("./helpers/relay-attested-harness");

// GST-2662: the guest notes broker's files (<root>/guest-writes: the
// loopback routes' secret, the gbrain OAuth client, the claims database) are
// refused in every relay session, like the relay's keys, and a change there
// is an anchor change. The owner's attested thread gets a plain refusal too.
const expectRefusedOutright = (result, label) => {
  expect(result.block, label).toBe(true);
  expect(result.blockReason, label).toMatch(/is refused in every relay session|would change what decides relay trust on this box/);
  expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
};

describe("relay guard keeps relay sessions away from the guest notes broker's files (GST-2662)", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  const brokerDir = (ctx) => {
    const dir = path.join(ctx.rootDir, "guest-writes");
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["internal-secret", "broker-client.json", "broker.db"]) fs.writeFileSync(path.join(dir, name), "x");
    return dir;
  };
  const reads = (dir) => [
    ["read tool on the broker credential", "read", { path: dir + "/broker-client.json" }],
    ["read tool on the internal secret", "read", { path: dir + "/internal-secret" }],
    ["read tool on the claims database", "read", { path: dir + "/broker.db" }],
    ["cat of the broker credential", "exec", { command: "cat " + dir + "/broker-client.json" }],
    ["cd into guest-writes, then cat", "exec", { command: "cd " + dir + " && cat internal-secret" }],
    ["cat of guest-writes/... from the root", "exec", { command: "cd " + path.dirname(dir) + " && cat guest-writes/broker-client.json" }],
    ["cd twice, then cat", "exec", { command: "cd " + path.dirname(dir) + " && cd guest-writes && cat broker-client.json" }],
    ["cd ../../guest-writes from the workspace", "exec", { command: "cd ../../guest-writes && cat internal-secret" }],
    ["a workdir in guest-writes", "exec", { command: "cat internal-secret", workdir: dir }],
    ["a glob in guest-writes", "exec", { command: "head -c 9999 " + dir + "/*" }],
    ["a glob prefix in guest-writes", "exec", { command: "cat " + dir + "/broker-c?ient.json" }],
    ["a recursive grep of guest-writes", "exec", { command: "grep -ra secret " + dir }],
    ["a glob that stands in for part of the directory name", "exec", { command: "cat " + path.dirname(dir) + "/guest-wr*/broker-client.json" }],
    ["a glob that stands in for the whole directory name", "exec", { command: "cat " + path.dirname(dir) + "/*/broker-client.json" }],
    ["a single-character glob in the directory name", "exec", { command: "cat " + path.dirname(dir) + "/guest-write?/internal-secret" }],
    ["cd into the root, then a relative glob", "exec", { command: "cd " + path.dirname(dir) + " && cat gues*/broker-client.json" }],
    ["a sqlite read of the claims database", "exec", { command: "sqlite3 " + dir + "/broker.db .dump" }],
    ["a relative glob with / as the workdir", "exec", { command: "cat " + path.dirname(dir).slice(1) + "/gu*/*", workdir: "/" }],
    ["a relative glob with a workdir at the root", "exec", { command: "cat gu*/internal-secret", workdir: path.dirname(dir) }],
    ["a relative glob with a relative workdir that climbs to the root", "exec", { command: "cat */broker-client.json", workdir: "../.." }],
    ["a read typed into a running shell", "process", { action: "write", sessionId: "s1", data: "cat " + dir + "/broker-client.json\n" }],
  ];
  const symlinked = (ctx) => {
    const workspace = path.join(ctx.rootDir, ".openclaw", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync(path.join(ctx.rootDir, "guest-writes"), path.join(workspace, "gw"));
    fs.symlinkSync(path.join(ctx.rootDir, "guest-writes", "broker-client.json"), path.join(workspace, "c.json"));
    fs.symlinkSync(".", path.join(workspace, "~"));
    return [
      ["a cat through a symlinked directory", "exec", { command: "cat gw/internal-secret" }],
      ["a cat through a symlinked file", "exec", { command: "cat c.json" }],
      ["a glob through a symlinked directory", "exec", { command: "cat g*/internal-secret" }],
      ["a workdir of ~, which OpenClaw joins onto the workspace", "exec", { command: "cat gw/internal-secret", workdir: "~" }],
      ["a workdir of ~/, which OpenClaw joins onto the workspace", "exec", { command: "cat c.json", workdir: "~/" }],
      ["a workdir under ~, which OpenClaw joins onto the workspace", "exec", { command: "cat internal-secret", workdir: "~/gw" }],
      ["a glob from a workdir of ~", "exec", { command: "cat g?/*", workdir: "~" }],
      ["a read tool through a symlinked file", "read", { path: path.join(workspace, "c.json") }],
      ["a cat with a ~ workdir OpenClaw joins onto the workspace", "exec", { command: "cat internal-secret", workdir: "~/gw" }],
    ];
  };
  // OpenClaw 2026.11.4 joins a workdir of ~ or ~/x onto the workspace instead
  // of expanding it, so ~/gw is <workspace>/~/gw; here that is guest-writes.
  const tildeWrites = (ctx) => {
    const workspace = path.join(ctx.rootDir, ".openclaw", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    if (!fs.existsSync(path.join(workspace, "gw"))) fs.symlinkSync(path.join(ctx.rootDir, "guest-writes"), path.join(workspace, "gw"));
    fs.rmSync(path.join(workspace, "~"), { force: true });
    fs.symlinkSync(".", path.join(workspace, "~"));
    return [
      ["overwrite the internal secret from a ~ workdir", "exec", { command: "echo mine > internal-secret", workdir: "~/gw" }],
      ["rm the claims database from a ~/ workdir", "exec", { command: "rm broker.db", workdir: "~/gw/" }],
    ];
  };
  const writes = (dir) => [
    ["a write tool on the internal secret", "write", { path: dir + "/internal-secret", content: "mine" }],
    ["overwrite the internal secret", "exec", { command: "echo mine > " + dir + "/internal-secret" }],
    ["cd into guest-writes, then rm the claims database", "exec", { command: "cd " + dir + " && rm broker.db" }],
  ];
  const ordinary = (dir) => [
    ["ls of the broker directory", "exec", { command: "ls " + dir }],
    ["a broker-client.json outside guest-writes", "exec", { command: "cat /tmp/app/broker-client.json" }],
    ["a note in the workspace", "exec", { command: "echo done >> memory/notes.md" }],
    ["a glob in the workspace", "exec", { command: "cat memory/*.md" }],
    ["a relative path outside guest-writes with / as the workdir", "exec", { command: "cat tmp/app/broker-client.json", workdir: "/" }],
    ["a listing glob of the root", "exec", { command: "ls gu*", workdir: path.dirname(dir) }],
  ];

  it("refuses an unattested delegate's reads of the broker's files outright, with no row and no notice", async () => {
    ctx = setup();
    const dir = brokerDir(ctx);
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    for (const [label, tool, params] of [...reads(dir), ...symlinked(ctx)]) {
      const result = await ctx.call(run, tool, params);
      expect(result.block, label).toBe(true);
      expect(result.blockReason, label).toContain("is refused in every relay session");
      expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
    }
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
  });

  it("refuses the same reads and any change there for the owner's attested thread", async () => {
    ctx = setup();
    const dir = brokerDir(ctx);
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    for (const [label, tool, params] of [...reads(dir), ...symlinked(ctx), ...writes(dir), ...tildeWrites(ctx)]) expectRefusedOutright(await ctx.call(run, tool, params), label);
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("keeps an unattested delegate's changes there from running", async () => {
    ctx = setup();
    const dir = brokerDir(ctx);
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    for (const [label, tool, params] of [...writes(dir), ...tildeWrites(ctx)]) expect((await ctx.call(run, tool, params)).block, label).toBe(true);
  });

  it("still runs a listing and ordinary calls for both tiers", async () => {
    ctx = setup();
    const dir = brokerDir(ctx);
    const unattested = await ctx.deliver(ctx.oauthDelegate().agent);
    const owner = await ctx.deliver((await ctx.attestedAgent()).agent);
    // A delegate that is not the owner's own thread runs no programs
    // (GST-2661); its listing and ordinary calls are the file tools.
    const files = [
      ["ls of the broker directory", "ls", { path: dir }],
      ["a broker-client.json outside guest-writes", "read", { path: "/tmp/app/broker-client.json" }],
      ["a note in the workspace", "write", { path: path.join(ctx.rootDir, ".openclaw", "workspace", "memory", "notes.md"), content: "done" }],
    ];
    for (const [label, tool, params] of files) expect(await ctx.call(unattested, tool, params), label).toEqual({});
    for (const [label, tool, params] of ordinary(dir)) expectProgramsRefused(ctx, unattested, tool, params, label);
    for (const [label, tool, params] of [...ordinary(dir), ...files]) expect(await ctx.call(owner, tool, params), label).toEqual({});
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("runs the owner's grep across a 1,200-page brain folder reached through a symlink, and refuses it once a page links into guest-writes (GST-3423)", async () => {
    ctx = setup();
    const dir = brokerDir(ctx);
    const people = path.join(ctx.rootDir, "stronghold-brain", "brain", "people");
    fs.mkdirSync(people, { recursive: true });
    for (let i = 0; i < 1200; i += 1) fs.writeFileSync(path.join(people, "person-" + i + ".md"), "role: friend\n");
    fs.symlinkSync(path.join(ctx.rootDir, "stronghold-brain", "brain"), path.join(ctx.rootDir, "brain"));
    const scan = { command: "cd " + path.join(ctx.rootDir, "brain", "people") + ' && grep -l -i -E "^(role|relationship):.*(doctor|dentist)" *.md 2>/dev/null | head -60' };
    const owner = await ctx.deliver((await ctx.attestedAgent()).agent);
    expect(await ctx.call(owner, "exec", scan)).toEqual({});
    fs.symlinkSync(path.join(dir, "broker-client.json"), path.join(people, "zz.md"));
    expectRefusedOutright(await ctx.call(owner, "exec", scan), "a page that links into guest-writes");
    const links = path.join(ctx.rootDir, "links");
    fs.mkdirSync(links);
    for (let i = 0; i < 2001; i += 1) fs.symlinkSync(path.join(people, "person-0.md"), path.join(links, "l" + i + ".md"));
    const capped = await ctx.call(owner, "exec", { command: "wc -l " + links + "/*.md" });
    expect(capped.block).toBe(true);
    expect(capped.blockReason).toContain("glob matches too many entries to check; narrow the pattern");
    expect(capped.blockReason).not.toContain("guest notes broker's files is refused");
  });
});
