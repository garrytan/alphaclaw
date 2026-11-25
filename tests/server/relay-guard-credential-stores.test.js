const fs = require("fs");
const path = require("path");
const { setup, expectProgramsRefused } = require("./helpers/relay-attested-harness");

// GST-3848: the credential stores outside the relay are refused in every
// relay session like the relay's keys, and a change there is an anchor
// change: AlphaClaw's Google Workspace state (<root>/google-workspace),
// GBrain's vault and broker socket folder ($GBRAIN_HOME/credentials.json and
// $GBRAIN_HOME/run), and OpenClaw's state database with its -wal, -shm and
// -journal files, whose rows hold MCP OAuth tokens. A process's command line
// (/proc/<pid>/cmdline) is refused beside its environment.
const expectRefusedOutright = (result, label) => {
  expect(result.block, label).toBe(true);
  expect(result.blockReason, label).toMatch(/is refused in every relay session|would change what decides relay trust on this box/);
  expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
};

describe("relay guard keeps relay sessions away from the box's credential stores (GST-3848)", () => {
  let ctx;
  let saved;
  beforeEach(() => {
    saved = { GBRAIN_HOME: process.env.GBRAIN_HOME, OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    ctx?.cleanup();
    ctx = null;
  });

  const stores = (ctx, { stateDir } = {}) => {
    const gbrain = path.join(ctx.rootDir, "gbrain-home");
    fs.mkdirSync(path.join(gbrain, "run"), { recursive: true });
    fs.writeFileSync(path.join(gbrain, "credentials.json"), "x");
    fs.writeFileSync(path.join(gbrain, "run", "google.sock"), "");
    process.env.GBRAIN_HOME = gbrain;
    const config = path.join(gbrain, ".gbrain");
    fs.mkdirSync(path.join(config, "run"), { recursive: true });
    fs.writeFileSync(path.join(config, "credentials.json"), "x");
    fs.writeFileSync(path.join(config, "run", "google.sock"), "");
    const state = path.join(stateDir || path.join(ctx.rootDir, ".openclaw"), "state");
    if (stateDir) process.env.OPENCLAW_STATE_DIR = stateDir;
    else delete process.env.OPENCLAW_STATE_DIR;
    fs.mkdirSync(state, { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) fs.writeFileSync(path.join(state, "openclaw.sqlite" + suffix), "x");
    const google = path.join(ctx.rootDir, "google-workspace");
    fs.mkdirSync(google, { recursive: true });
    fs.writeFileSync(path.join(google, "audit.jsonl"), "x");
    return { gbrain, state, google };
  };
  const reads = ({ gbrain, state, google }) => [
    ["read tool on the state database", "read", { path: state + "/openclaw.sqlite" }],
    ["read tool on the state database's -wal file", "read", { path: state + "/openclaw.sqlite-wal" }],
    ["read tool on the state database's -shm file", "read", { path: state + "/openclaw.sqlite-shm" }],
    ["read tool on a -journal file not yet on disk", "read", { path: state + "/openclaw.sqlite-journal" }],
    ["sqlite dump of the OAuth stores", "exec", { command: "sqlite3 " + state + "/openclaw.sqlite 'select * from mcp_oauth_stores'" }],
    ["strings of the -wal file", "exec", { command: "strings " + state + "/openclaw.sqlite-wal" }],
    ["cd into the state folder, then cat", "exec", { command: "cd " + state + " && cat openclaw.sqlite" }],
    ["the state database from the workspace", "exec", { command: "cat ../state/openclaw.sqlite" }],
    ["a glob over the database and its sidecars", "exec", { command: "cat " + state + "/openclaw.sql*" }],
    ["a glob for the state folder's name", "exec", { command: "cat " + path.dirname(state) + "/st*/openclaw.sqlite-shm" }],
    ["a workdir in the state folder", "exec", { command: "head -c 4096 openclaw.sqlite", workdir: state }],
    ["read tool on GBrain's vault", "read", { path: gbrain + "/credentials.json" }],
    ["read tool on the vault in GBrain's config dir", "read", { path: gbrain + "/.gbrain/credentials.json" }],
    ["cat of the vault through GBRAIN_HOME's config dir", "exec", { command: "cat $GBRAIN_HOME/.gbrain/credentials.json" }],
    ["a talk to the broker socket in the config dir", "exec", { command: "socat - UNIX-CONNECT:" + gbrain + "/.gbrain/run/google.sock" }],
    ["a glob in the config dir's run folder", "exec", { command: "nc -U " + gbrain + "/.gbrain/run/g*" }],
    ["cat of GBrain's vault", "exec", { command: "cat " + gbrain + "/credentials.json" }],
    ["cat of the vault through GBRAIN_HOME", "exec", { command: "cat $GBRAIN_HOME/credentials.json" }],
    ["cat of the vault through ~/.gbrain", "exec", { command: "cat ~/.gbrain/credentials.json" }],
    ["a talk to the broker socket", "exec", { command: "socat - UNIX-CONNECT:" + gbrain + "/run/google.sock" }],
    ["a curl to the broker socket by name", "exec", { command: "curl --unix-socket /somewhere/google.sock http://x/" }],
    ["a glob in the broker folder", "exec", { command: "nc -U " + gbrain + "/run/*" }],
    ["cd into GBrain's home, then cat", "exec", { command: "cd " + gbrain + " && cat credentials.json" }],
    ["a workdir in GBrain's run folder", "exec", { command: "nc -U google.sock", workdir: gbrain + "/run" }],
    ["read tool on the Google Workspace audit", "read", { path: google + "/audit.jsonl" }],
    ["cat of the Google Workspace audit", "exec", { command: "cat " + google + "/audit.jsonl" }],
    ["cd ../../google-workspace from the workspace", "exec", { command: "cd ../../google-workspace && cat audit.jsonl" }],
    ["a glob for the Google Workspace folder", "exec", { command: "cat " + ctx_root(google) + "/google-w*/*" }],
    ["a recursive grep of the Google Workspace folder", "exec", { command: "grep -ra token " + google }],
    ["a read typed into a running shell", "process", { action: "write", sessionId: "s1", data: "sqlite3 " + state + "/openclaw.sqlite .dump\n" }],
    ["read tool on this process's command line", "read", { path: "/proc/self/cmdline" }],
    ["cat of a process's command line", "exec", { command: "cat /proc/1/cmdline" }],
    ["cat of a thread's command line", "exec", { command: "cat /proc/1/task/2/cmdline" }],
    ["a glob over every command line", "exec", { command: "tr '\\0' ' ' < /proc/*/cmdline" }],
    ["a pid the shell fills in", "exec", { command: "cat /proc/$(pgrep gwscli)/cmdline" }],
  ];
  const ctx_root = (dir) => path.dirname(dir);
  const symlinked = (ctx, { state, gbrain }) => {
    const workspace = path.join(ctx.rootDir, ".openclaw", "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync(path.join(state, "openclaw.sqlite"), path.join(workspace, "db"));
    fs.symlinkSync(gbrain, path.join(workspace, "gb"));
    return [
      ["a cat through a symlinked database", "exec", { command: "cat db" }],
      ["a cat through a symlinked GBrain home", "exec", { command: "cat gb/credentials.json" }],
      ["a read tool through a symlinked database", "read", { path: path.join(workspace, "db") }],
    ];
  };
  const writes = ({ gbrain, state, google }) => [
    ["a write tool on the state database", "write", { path: state + "/openclaw.sqlite", content: "mine" }],
    ["rm of the -wal file", "exec", { command: "rm " + state + "/openclaw.sqlite-wal" }],
    ["a sqlite update of the OAuth stores", "exec", { command: "cd " + state + " && sqlite3 openclaw.sqlite 'delete from mcp_oauth_stores'" }],
    ["overwrite GBrain's vault", "exec", { command: "echo {} > " + gbrain + "/credentials.json" }],
    ["rm of the broker socket", "exec", { command: "rm " + gbrain + "/run/google.sock" }],
    ["a write tool on the Google Workspace audit", "write", { path: google + "/audit.jsonl", content: "" }],
  ];
  const ordinary = ({ gbrain, google }) => [
    ["ls of GBrain's run folder", "exec", { command: "ls " + gbrain + "/run" }],
    ["ls of the Google Workspace folder", "exec", { command: "ls -la " + google }],
    ["a credentials.json of another app", "exec", { command: "cat /tmp/app/credentials.json" }],
    ["a note that names the state database", "exec", { command: "echo 'checked openclaw.sqlite' >> memory/notes.md" }],
    ["a note file named after the database", "exec", { command: "cat memory/openclaw.sqlite.md" }],
    ["a note about Google Workspace", "exec", { command: "cat memory/google-workspace-notes.md" }],
    ["a glob in the workspace", "exec", { command: "cat memory/*.md" }],
    ["a process's status", "exec", { command: "cat /proc/1/status" }],
  ];

  it("refuses an unattested delegate's reads of the credential stores outright, with no row and no notice", async () => {
    ctx = setup();
    const dirs = stores(ctx);
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    for (const [label, tool, params] of [...reads(dirs), ...symlinked(ctx, dirs)]) {
      const result = await ctx.call(run, tool, params);
      expect(result.block, label).toBe(true);
      expect(result.blockReason, label).toContain("is refused in every relay session");
      expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
    }
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
  });

  it("refuses the same reads and any change there for the owner's attested thread, naming the store", async () => {
    ctx = setup();
    const dirs = stores(ctx);
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    for (const [label, tool, params] of [...reads(dirs), ...symlinked(ctx, dirs), ...writes(dirs)]) expectRefusedOutright(await ctx.call(run, tool, params), label);
    const db = await ctx.call(run, "read", { path: dirs.state + "/openclaw.sqlite-wal" });
    expect(db.blockReason).toContain("OpenClaw's state database holds tokens for the box's accounts");
    const vault = await ctx.call(run, "read", { path: dirs.gbrain + "/credentials.json" });
    expect(vault.blockReason).toContain("GBrain's credential store holds tokens for the box's accounts");
    const google = await ctx.call(run, "read", { path: dirs.google + "/audit.jsonl" });
    expect(google.blockReason).toContain("AlphaClaw's Google Workspace state holds tokens for the box's accounts");
    const change = await ctx.call(run, "exec", { command: "sqlite3 " + dirs.state + "/openclaw.sqlite .dump" });
    expect(change.blockReason).toContain("a credential store for the box's accounts");
    const cmdline = await ctx.call(run, "exec", { command: "cat /proc/1/cmdline" });
    expect(cmdline.blockReason).toContain("(/proc/<pid>/environ or cmdline) is refused in every relay session");
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("follows OPENCLAW_STATE_DIR to a state database outside the root", async () => {
    ctx = setup();
    const dirs = stores(ctx, { stateDir: path.join(ctx.rootDir, "elsewhere", "oc-state") });
    const run = await ctx.deliver((await ctx.attestedAgent()).agent);
    expectRefusedOutright(await ctx.call(run, "read", { path: dirs.state + "/openclaw.sqlite-wal" }), "a read of the moved -wal file");
    expectRefusedOutright(await ctx.call(run, "exec", { command: "rm " + dirs.state + "/openclaw.sqlite" }), "an rm of the moved database");
  });

  it("keeps an unattested delegate's changes there from running", async () => {
    ctx = setup();
    const dirs = stores(ctx);
    const run = await ctx.deliver(ctx.oauthDelegate().agent);
    for (const [label, tool, params] of writes(dirs)) expect((await ctx.call(run, tool, params)).block, label).toBe(true);
  });

  it("still runs a listing and ordinary calls for both tiers", async () => {
    ctx = setup();
    const dirs = stores(ctx);
    const unattested = await ctx.deliver(ctx.oauthDelegate().agent);
    const owner = await ctx.deliver((await ctx.attestedAgent()).agent);
    const files = [
      ["ls of GBrain's run folder", "ls", { path: dirs.gbrain + "/run" }],
      ["a credentials.json of another app", "read", { path: "/tmp/app/credentials.json" }],
      ["a note in the workspace", "write", { path: path.join(ctx.rootDir, ".openclaw", "workspace", "memory", "notes.md"), content: "done" }],
    ];
    for (const [label, tool, params] of files) expect(await ctx.call(unattested, tool, params), label).toEqual({});
    for (const [label, tool, params] of ordinary(dirs)) expectProgramsRefused(ctx, unattested, tool, params, label);
    for (const [label, tool, params] of [...ordinary(dirs), ...files]) expect(await ctx.call(owner, tool, params), label).toEqual({});
    expect(ctx.confirmationCount()).toBe(0);
  });

  it("treats a change to the Google Workspace plugin's openclaw.json entry as an anchor change", async () => {
    ctx = setup();
    const owner = await ctx.deliver((await ctx.attestedAgent()).agent);
    const config = JSON.parse(fs.readFileSync(ctx.openclawJson, "utf8"));
    config.plugins.entries["google-workspace"] = { enabled: true, config: {} };
    const changes = [
      ["openclaw config set on the plugin's entry", "exec", { command: "openclaw config set plugins.entries.google-workspace.enabled true" }],
      ["openclaw config set on the plugin's config, bracketed", "exec", { command: "openclaw config set 'plugins.entries[\"google-workspace\"].config.accounts' '[]'" }],
      ["openclaw plugins enable", "exec", { command: "openclaw plugins enable google-workspace" }],
      ["openclaw plugins disable", "exec", { command: "openclaw plugins disable google-workspace" }],
      ["the plugins tool enabling it", "plugins", { action: "enable", pluginId: "google-workspace" }],
      ["a write of openclaw.json that adds the entry", "write", { path: ctx.openclawJson, content: JSON.stringify(config, null, 2) }],
    ];
    for (const [label, tool, params] of changes) expectRefusedOutright(await ctx.call(owner, tool, params), label);
    const unattested = await ctx.deliver(ctx.oauthDelegate().agent);
    expect((await ctx.call(unattested, "plugins", { action: "enable", pluginId: "google-workspace" })).block).toBe(true);
    expect(await ctx.call(owner, "exec", { command: "openclaw config set plugins.entries.other-plugin.enabled true" })).toEqual({});
    expect(await ctx.call(owner, "plugins", { action: "enable", pluginId: "other-plugin" })).toEqual({});
  });
});
