const fs = require("fs");
const path = require("path");
const { setup } = require("./helpers/relay-attested-harness");

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
    ["a sqlite read of the claims database", "exec", { command: "sqlite3 " + dir + "/broker.db .dump" }],
    ["a read typed into a running shell", "process", { action: "write", sessionId: "s1", data: "cat " + dir + "/broker-client.json\n" }],
  ];
  const symlinked = (ctx) => {
    const workspace = path.join(ctx.rootDir, ".openclaw", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync(path.join(ctx.rootDir, "guest-writes"), path.join(workspace, "gw"));
    fs.symlinkSync(path.join(ctx.rootDir, "guest-writes", "broker-client.json"), path.join(workspace, "c.json"));
    return [
      ["a cat through a symlinked directory", "exec", { command: "cat gw/internal-secret" }],
      ["a cat through a symlinked file", "exec", { command: "cat c.json" }],
      ["a read tool through a symlinked file", "read", { path: path.join(workspace, "c.json") }],
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
    for (const [label, tool, params] of [...reads(dir), ...symlinked(ctx), ...writes(dir)]) expectRefusedOutright(await ctx.call(run, tool, params), label);
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("keeps an unattested delegate's changes there from running", async () => {
    ctx = setup();
    const dir = brokerDir(ctx);
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    for (const [label, tool, params] of writes(dir)) expect((await ctx.call(run, tool, params)).block, label).toBe(true);
  });

  it("still runs a listing and ordinary calls for both tiers", async () => {
    ctx = setup();
    const dir = brokerDir(ctx);
    for (const run of [await ctx.deliver(ctx.oauthDelegate().agent), await ctx.deliver((await ctx.attestedAgent()).agent)]) {
      for (const [label, tool, params] of ordinary(dir)) expect(await ctx.call(run, tool, params), label).toEqual({});
    }
    expect(ctx.confirmationCount()).toBe(0);
  });
});
