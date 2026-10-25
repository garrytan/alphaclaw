const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const { createProcessTable, parseEnvKeys } = require("../../lib/server/box-status/processes");
const { registerBoxRoutes } = require("../../lib/server/routes/box");

const kSecret = "hunter2-database-password";
const kToken = "sk-abcdefghijklmnopqrstuvwx";

const writeProc = (root, { pid, name, parentPid, startTicks = 50000, uid = 1000, rssKb = 1024, argv = [name], environ = {}, pssKb = null, exe = null }) => {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "stat"), pid + " (" + name + ") S " + parentPid + " " + Array(17).fill("0").join(" ") + " " + startTicks + " 0 0\n");
  fs.writeFileSync(path.join(dir, "status"), "Name:\t" + name + "\nUid:\t" + uid + "\t" + uid + "\t" + uid + "\t" + uid + "\nVmRSS:\t" + rssKb + " kB\n");
  fs.writeFileSync(path.join(dir, "cmdline"), argv.join("\0") + "\0");
  fs.writeFileSync(path.join(dir, "environ"), Object.entries(environ).map(([k, v]) => k + "=" + v).join("\0") + "\0");
  if (pssKb !== null) fs.writeFileSync(path.join(dir, "smaps_rollup"), "Rss:\t" + rssKb + " kB\nPss:\t" + pssKb + " kB\n");
  if (exe) fs.symlinkSync(exe, path.join(dir, "exe"));
};

const makeBox = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "box-proc-"));
  const proc = path.join(root, "proc");
  fs.mkdirSync(proc);
  fs.writeFileSync(path.join(proc, "uptime"), "1000.00 4000.00\n");
  fs.writeFileSync(path.join(root, "passwd"), "root:x:0:0::/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/sh\n");
  writeProc(proc, { pid: 1, name: "tini", parentPid: 0, startTicks: 0, uid: 0, rssKb: 100 });
  writeProc(proc, { pid: 10, name: "node", parentPid: 1, startTicks: 10000, rssKb: 50000, pssKb: 40000,
    argv: ["node", "bin/alphaclaw.js", "start"], environ: { DATABASE_URL: "new-value" }, exe: process.execPath });
  writeProc(proc, { pid: 20, name: "openclaw", parentPid: 10, startTicks: 60000, rssKb: 30000, argv: ["openclaw", "gateway", "run"] });
  writeProc(proc, { pid: 21, name: "openclaw-gatewa", parentPid: 20, startTicks: 60100, rssKb: 400000, pssKb: 380000,
    argv: ["node", "openclaw", "gateway"], environ: { DATABASE_URL: "old-value" } });
  writeProc(proc, { pid: 30, name: "bash", parentPid: 21, startTicks: 90000, rssKb: 2000, argv: ["bash", "-c", "ls"] });
  writeProc(proc, { pid: 40, name: "openclaw", parentPid: 10, startTicks: 95000, rssKb: 8000, argv: ["openclaw", "doctor", "--lint", "--json"] });
  writeProc(proc, { pid: 50, name: "kb-daemon", parentPid: 1, startTicks: 2000, rssKb: 900000,
    argv: ["kb-daemon", "--token", kToken, "--db", "postgres://u:" + kSecret + "@db/x", "--password=" + kSecret],
    environ: { DATABASE_URL: "new-value", OTHER: "x" } });
  return { root, proc, passwd: path.join(root, "passwd") };
};

const createTable = (box, overrides = {}) => createProcessTable({
  procRoot: box.proc,
  passwdPath: box.passwd,
  selfPid: 10,
  getGatewayTarget: () => ({ gatewayRootPid: 20, gatewayPid: 21 }),
  readEnvFile: () => [{ key: "DATABASE_URL", value: "new-value" }, { key: "DB_PASSWORD", value: kSecret }],
  alphaclawVersion: "0.10.119",
  getOpenclawVersion: () => "2026.10.7",
  env: {},
  nowFn: () => 1_800_000_000_000,
  ...overrides,
});

describe("box process table", () => {
  let box;
  beforeEach(() => { box = makeBox(); });
  afterEach(() => fs.rmSync(box.root, { recursive: true, force: true }));

  it("names the owner of every process and sorts by RSS", async () => {
    const result = await createTable(box).read();
    expect(result.status).toBe("fresh");
    expect(result.total).toBe(7);
    const byPid = Object.fromEntries(result.processes.map((row) => [row.pid, row]));
    expect(result.processes.map((row) => row.pid)).toEqual([50, 21, 10, 20, 40, 30, 1]);
    expect([byPid[20].owner, byPid[20].role]).toEqual(["gateway", "launcher"]);
    expect([byPid[21].owner, byPid[21].role]).toEqual(["gateway", "worker"]);
    expect([byPid[30].owner, byPid[30].role]).toEqual(["tool", "gateway_child"]);
    expect([byPid[10].owner, byPid[10].role]).toEqual(["alphaclaw", "server"]);
    expect([byPid[40].owner, byPid[40].role]).toEqual(["alphaclaw", "child"]);
    expect([byPid[1].owner, byPid[1].role]).toEqual(["other", "ancestor"]);
    expect([byPid[50].owner, byPid[50].role]).toEqual(["other", null]);
    expect(byPid[10].version).toBe("alphaclaw 0.10.119");
    expect(byPid[21].version).toBe("openclaw 2026.10.7");
    expect(byPid[20].version).toBe("openclaw 2026.10.7");
    expect(byPid[50].version).toBeNull();
    expect(byPid[10].runtime).toBe("node " + process.version);
    expect(byPid[1].user).toBe("root");
    expect(byPid[50].user).toBe("node");
    expect(byPid[50].uptimeSec).toBe(980);
    expect(byPid[50].startedAt).toBe(new Date(1_800_000_000_000 - 980_000).toISOString());
    expect(byPid[21].rssBytes).toBe(400000 * 1024);
    expect(byPid[21].pssBytes).toBe(380000 * 1024);
    expect(byPid[50].pssBytes).toBeNull();
    expect(result.totals.gateway).toEqual({ count: 2, rssBytes: 430000 * 1024 });
    expect(result.totals.tool.count).toBe(1);
    expect(result.totals.alphaclaw.count).toBe(2);
    expect(result.totals.other.count).toBe(2);
  });

  it("redacts secrets from command lines", async () => {
    const result = await createTable(box).read();
    const daemon = result.processes.find((row) => row.pid === 50);
    expect(daemon.command.startsWith("kb-daemon")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(kSecret);
    expect(JSON.stringify(result)).not.toContain(kToken);
  });

  it("redacts the value after a secret-named flag even when it has no secret shape", async () => {
    writeProc(box.proc, { pid: 60, name: "svc", parentPid: 1, startTicks: 3000, rssKb: 1000,
      argv: ["node", "svc.js", "--token", "plain-words-1", "--api-key=plain-words-2", "--port", "9123"] });
    const result = await createTable(box).read();
    const svc = result.processes.find((row) => row.pid === 60);
    expect(svc.command).toContain("--port 9123");
    expect(svc.command).not.toContain("plain-words-1");
    expect(svc.command).not.toContain("plain-words-2");
  });

  it("fingerprints selected env keys without returning values", async () => {
    const result = await createTable(box).read({ envKeys: ["DATABASE_URL", "OTHER", "MISSING"] });
    const byPid = Object.fromEntries(result.processes.map((row) => [row.pid, row]));
    expect(byPid[10].env.keys.DATABASE_URL.envFile).toBe("match");
    expect(byPid[50].env.keys.DATABASE_URL.envFile).toBe("match");
    expect(byPid[21].env.keys.DATABASE_URL.envFile).toBe("mismatch");
    expect(byPid[50].env.keys.OTHER.envFile).toBe("not_in_env_file");
    expect(byPid[50].env.keys.MISSING).toEqual({ hash: null, envFile: "unset" });
    expect(byPid[10].env.keys.DATABASE_URL.hash).toBe(byPid[50].env.keys.DATABASE_URL.hash);
    expect(byPid[10].env.keys.DATABASE_URL.hash).toBe(result.envFile.DATABASE_URL);
    expect(byPid[21].env.keys.DATABASE_URL.hash).not.toBe(result.envFile.DATABASE_URL);
    expect(byPid[10].env.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const json = JSON.stringify(result);
    expect(json).not.toContain("new-value");
    expect(json).not.toContain("old-value");
  });

  it("leaves env out unless keys are selected", async () => {
    const result = await createTable(box).read();
    expect(result.processes.every((row) => row.env === undefined)).toBe(true);
    expect(result.envFile).toBeUndefined();
  });

  it("returns the largest processes up to the limit, totals over all", async () => {
    const result = await createTable(box).read({ limit: 2 });
    expect(result.processes.map((row) => row.pid)).toEqual([50, 21]);
    expect(result.shown).toBe(2);
    expect(result.total).toBe(7);
    expect(result.totals.alphaclaw.count).toBe(2);
  });

  it("serves a fresh read from cache and rescans after the cache window", async () => {
    let now = 1_800_000_000_000;
    const table = createTable(box, { nowFn: () => now });
    const first = await table.read();
    fs.rmSync(path.join(box.proc, "50"), { recursive: true });
    expect(await table.read()).toBe(first);
    now += 5000;
    const second = await table.read();
    expect(second.total).toBe(6);
  });

  it("reports a partial read when the scan budget runs out", async () => {
    let ticks = 0;
    const table = createTable(box, { monotonicNowFn: () => { ticks += 1; return ticks > 4 ? 10_000 : 0; } });
    const result = await table.read();
    expect(result.status).toBe("partial");
    expect(result.reason).toBe("scan_deadline");
    expect(result.total).toBeLessThan(7);
  });

  it("says when /proc cannot be read", async () => {
    const result = await createTable(box, { procRoot: path.join(box.root, "missing") }).read();
    expect(result).toMatchObject({ ok: true, status: "unavailable", reason: "proc_unavailable", processes: [] });
  });
});

describe("parseEnvKeys", () => {
  it("accepts up to 8 unique names and rejects anything else", () => {
    expect(parseEnvKeys(undefined)).toEqual({ keys: [] });
    expect(parseEnvKeys("A, B,A")).toEqual({ keys: ["A", "B"] });
    expect(parseEnvKeys("A,B,C,D,E,F,G,H,I").error).toMatch(/at most 8/);
    expect(parseEnvKeys("A;rm").error).toMatch(/invalid/);
    expect(parseEnvKeys(["A", "B"]).error).toMatch(/once/);
  });
});

describe("GET /api/box/processes", () => {
  const createApp = (processTable) => {
    const app = express();
    registerBoxRoutes({ app, requireAuth: (req, res, next) => next(), processTable });
    return app;
  };

  it("passes the parsed keys and limit to the table", async () => {
    const read = vi.fn(async () => ({ ok: true, processes: [] }));
    const res = await request(createApp({ read })).get("/api/box/processes?envKeys=A,B&limit=20");
    expect(res.status).toBe(200);
    expect(read).toHaveBeenCalledWith({ envKeys: ["A", "B"], limit: 20 });
  });

  it("rejects bad keys and limits with 400", async () => {
    const read = vi.fn();
    const app = createApp({ read });
    expect((await request(app).get("/api/box/processes?envKeys=a%20b")).body.error).toBe("invalid_env_keys");
    expect((await request(app).get("/api/box/processes?limit=0")).body.error).toBe("invalid_limit");
    expect((await request(app).get("/api/box/processes?limit=501")).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers an unknown view with 404 and the list of views", async () => {
    const res = await request(createApp({ read: vi.fn() })).get("/api/box/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: "unknown_view", views: ["processes"] });
  });

  it("does not treat inherited object keys as views", async () => {
    const res = await request(createApp({ read: vi.fn() })).get("/api/box/constructor");
    expect(res.status).toBe(404);
  });
});
