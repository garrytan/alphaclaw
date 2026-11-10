const fs = require("fs");
const path = require("path");
const { setup, expectHeldWithTap } = require("./helpers/relay-attested-harness");

// GST-2336: the trust anchor is checked for every delegate tier, and no relay
// session reads the relay's keys or databases.
describe("relay anchor for every delegate tier (GST-2336)", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  const keyReads = (relay) => [
    ["read tool on secrets.json", "read", { path: relay + "/secrets.json" }],
    ["read tool on bridge.db", "read", { path: relay + "/bridge.db" }],
    ["cat of secrets.json", "exec", { command: "cat " + relay + "/secrets.json" }],
    ["cat of the provenance key", "exec", { command: "cat " + relay + "/provenance-key.json" }],
    ["cat of the internal secret", "exec", { command: "cat " + relay + "/internal.secret" }],
    ["cd into relay, then cat secrets.json", "exec", { command: "cd " + relay + " && cat secrets.json" }],
    ["cat of relay/secrets.json from the root", "exec", { command: "cd " + path.dirname(relay) + " && cat relay/secrets.json" }],
    ["cat of secrets.json with a workdir in relay", "exec", { command: "cat secrets.json", workdir: relay }],
    ["head of remote.db", "exec", { command: "head -c 100 " + relay + "/remote.db" }],
    ["grep in bridge.db-wal", "exec", { command: "grep -a text " + relay + "/bridge.db-wal" }],
  ];
  const relayWrites = (relay) => [
    ["cd into relay, then rm bridge.db", "exec", { command: "cd " + relay + " && rm bridge.db" }],
    ["rm bridge.db with a workdir in relay", "exec", { command: "rm bridge.db", workdir: relay }],
    ["cd into relay, then overwrite remote.db", "exec", { command: "cd " + relay + " && echo x > remote.db" }],
    ["rm through relay/../relay", "exec", { command: "cd " + relay + "/../relay && rm -f bridge.db" }],
  ];
  const ordinary = (relay) => [
    ["ls of the relay directory", "exec", { command: "ls " + relay }],
    ["a plain grep", "exec", { command: "grep -rn needle notes" }],
    ["a note in the workspace", "exec", { command: "echo done >> memory/notes.md" }],
    ["a secrets.json outside relay", "exec", { command: "cat /tmp/app/secrets.json" }],
  ];

  it("refuses an unattested delegate's reads of the relay's keys and databases outright, with no row and no notice", async () => {
    ctx = setup();
    const relay = path.join(ctx.rootDir, "relay");
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    for (const [label, tool, params] of keyReads(relay)) {
      const result = await ctx.call(run, tool, params);
      expect(result.block, label).toBe(true);
      expect(result.blockReason, label).toContain("is refused in every relay session");
      expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
    }
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
  });

  it("refuses the same reads for the owner's attested thread", async () => {
    ctx = setup();
    const relay = path.join(ctx.rootDir, "relay");
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    for (const [label, tool, params] of keyReads(relay)) expect((await ctx.call(run, tool, params)).blockReason, label).toContain("is refused in every relay session");
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("holds an unattested delegate's low-risk changes inside relay/ for the owner's tap", async () => {
    ctx = setup();
    const relay = path.join(ctx.rootDir, "relay");
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    for (const [, tool, params] of relayWrites(relay)) expectHeldWithTap(ctx, run, tool, params);
    expect(fs.existsSync(path.join(relay, "bridge.db"))).toBe(true);
  });

  it("refuses the same changes outright for the owner's attested thread", async () => {
    ctx = setup();
    const relay = path.join(ctx.rootDir, "relay");
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    for (const [label, tool, params] of relayWrites(relay)) expect((await ctx.call(run, tool, params)).blockReason, label).toContain("would change what decides relay trust on this box");
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("still runs ordinary calls for both tiers with no row and no notice", async () => {
    ctx = setup();
    const relay = path.join(ctx.rootDir, "relay");
    for (const run of [await ctx.deliver(ctx.oauthDelegate().agent), await ctx.deliver((await ctx.attestedAgent()).agent)]) {
      for (const [label, tool, params] of ordinary(relay)) expect(await ctx.call(run, tool, params), label).toEqual({});
    }
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
  });
});
