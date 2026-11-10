const fs = require("fs");
const path = require("path");
const { setup } = require("./helpers/relay-attested-harness");

// GST-2336: the trust anchor is checked for every delegate tier, and no relay
// session reads the relay's keys or databases.
// The owner's attested thread gets a plain refusal, from the anchor rule or
// the relay-file rule, whichever matches first; never a confirmation ref.
const expectRefusedOutright = (result, label) => {
  expect(result.block, label).toBe(true);
  expect(result.blockReason, label).toMatch(/is refused in every relay session|would change what decides relay trust on this box/);
  expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
};

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
    ["a glob in relay", "exec", { command: "cat " + relay + "/secret?.json" }],
    ["every file in relay", "exec", { command: "head -c 9999 " + relay + "/*" }],
    ["a recursive grep of relay", "exec", { command: "grep -ra . " + relay }],
    ["cd twice, then cat secrets.json", "exec", { command: "cd " + path.dirname(relay) + " && cd relay && cat secrets.json" }],
    ["cd ../../relay from the workspace", "exec", { command: "cd ../../relay && cat secrets.json" }],
    ["a note, then a cat of the provenance key", "exec", { command: "echo done >> /tmp/notes.md && cat " + relay + "/provenance-key.json" }],
    ["a read typed into a running shell", "process", { action: "write", sessionId: "s1", data: "cd " + relay + " && cat secrets.json\n" }],
    ["the internal secret typed into a running shell", "process", { action: "write", sessionId: "s1", data: "cat " + relay + "/internal.secret\n" }],
    ["a read tool on a Back up now copy", "read", { path: path.dirname(relay) + "/20261110-relay-backup/secrets.json" }],
    ["a cat of a Back up now copy", "exec", { command: "cat " + path.dirname(relay) + "/20261110-relay-backup/secrets.json" }],
    ["a redirect glued to the command and a glob", "exec", { command: "cat<../../relay/./secret?.json" }],
    ["a redirect glued to the command", "exec", { command: "cat<../../relay/./secrets.json" }],
    ["hex bytes sent to a running shell", "process", { action: "send-keys", sessionId: "s1", hex: Buffer.from("cat " + relay + "/secrets.json\n").toString("hex") }],
    ["a cd typed into a running shell", "process", { action: "write", sessionId: "s1", data: "cd " + relay + "\n" }],
    ["a workdir in a Back up now copy", "exec", { command: "cat secrets.json", workdir: path.dirname(relay) + "/2026-11-10T00-00-00Z-relay-backup" }],
    ["a read of an unfinished Back up now copy", "read", { path: path.dirname(relay) + "/2026-11-10T00-00-00Z-relay-backup.partial/secrets.json" }],
  ];
  const symlinked = (ctx) => {
    const workspace = path.join(ctx.rootDir, ".openclaw", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync(path.join(ctx.rootDir, "relay"), path.join(workspace, "rl"));
    fs.symlinkSync(path.join(ctx.rootDir, "relay", "secrets.json"), path.join(workspace, "s.json"));
    return [
      ["a cat through a symlinked directory", "exec", { command: "cat rl/secrets.json" }],
      ["a cat through a symlinked file", "exec", { command: "cat s.json" }],
    ];
  };
  const relayWrites = (relay) => [
    ["cd into the root, then into relay, then rm secrets.json", "exec", { command: "cd " + path.dirname(relay) + " && cd relay && rm secrets.json" }],
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

  it("refuses the same reads for the owner's attested thread, through workspace symlinks too", async () => {
    ctx = setup();
    const relay = path.join(ctx.rootDir, "relay");
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    for (const [label, tool, params] of [...keyReads(relay), ...symlinked(ctx)]) expectRefusedOutright(await ctx.call(run, tool, params), label);
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("refuses an unattested delegate's changes to the relay's files outright, with no row and no notice", async () => {
    ctx = setup();
    const relay = path.join(ctx.rootDir, "relay");
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    for (const [label, tool, params] of relayWrites(relay)) expect((await ctx.call(run, tool, params)).blockReason, label).toContain("is refused in every relay session");
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
  });

  it("holds an unattested delegate's low-rated change to AlphaClaw's installed code for the tap, and an approval admits that one call once", async () => {
    ctx = setup();
    const repoRoot = path.resolve(__dirname, "..", "..");
    const params = { command: "touch x", workdir: path.join(repoRoot, "lib") };
    const { agent } = ctx.oauthDelegate();
    const first = await ctx.deliver(agent);
    const held = await ctx.call(first, "exec", params);
    expect(held.blockReason).toContain("run a command inside AlphaClaw's relay or install files needs your owner's confirmation");
    const ref = /rc_[a-f0-9]{16}/.exec(held.blockReason)[0];
    expect(ctx.confirmationCount()).toBe(1);
    ctx.confirmations.tick();
    expect(ctx.bridgeStore.confirmations.decide(ref, { state: "confirmed", by: "owner", expiresAt: ctx.clock.now + 600000 })).toBe(true);
    const retry = await ctx.deliver(agent, { relay_generation: 1, relay_route: "public", relay_confirmation_ref: ref });
    expect(await ctx.call(retry, "exec", { command: "touch y", workdir: params.workdir })).toMatchObject({ block: true });
    expect(await ctx.call(retry, "exec", params)).toEqual({});
    expect(ctx.bridgeStore.confirmations.get(ref)).toMatchObject({ state: "spent" });
    expect((await ctx.call(retry, "exec", params)).block).toBe(true);
  });

  it("refuses the same changes outright for the owner's attested thread", async () => {
    ctx = setup();
    const relay = path.join(ctx.rootDir, "relay");
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    for (const [label, tool, params] of relayWrites(relay)) expectRefusedOutright(await ctx.call(run, tool, params), label);
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
