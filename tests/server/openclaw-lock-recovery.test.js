const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  recoverStaleForeignGatewayLock,
  resolveGatewayLockDir,
  sleepUnlessAborted,
} = require("../../lib/server/openclaw-lock-recovery");

const current = { host: "box-b", pidNsInode: "4026532999" };
const now = 1_800_000_000_000;
let root;
let lockDir;
const writeLock = (name, namespace, ageMs) => {
  const file = path.join(lockDir, name);
  fs.writeFileSync(file, JSON.stringify({ pid: 132, role: "gateway", processNamespace: { platform: "linux", ...namespace } }, null, 2) + "\n\t \t\n");
  const at = new Date(now - ageMs);
  fs.utimesSync(file, at, at);
};
const holderLine = (host, ns, ageS) =>
  ns
    ? `${lockDir}/gateway.state.lock: holder 132 at ${host}/pid-ns ${ns}, last renewed ${ageS} s ago. Stop the holder before retrying.`
    : `SQLite Gateway owner lease: holder 191 at unknown host, last renewed ${ageS} s ago. Stop the holder before retrying.`;
const cli = (inspection, recovered = { recovered: true, removed: inspection.holders.length }) => {
  const calls = [];
  const runCli = vi.fn(async (args) => {
    calls.push(args);
    if (args.includes("--confirm")) return { ok: true, stdout: JSON.stringify(recovered), stderr: "" };
    return { ok: true, stdout: JSON.stringify({ present: inspection.holders.length > 0, confirmation: "f".repeat(64), ...inspection }), stderr: "" };
  });
  return { runCli, calls };
};
const run = (options) =>
  recoverStaleForeignGatewayLock({
    openclawDir: root,
    current,
    nowMs: () => now,
    readLease: () => ({ status: "missing" }),
    logger: { log: () => {}, warn: () => {} },
    sleep: async () => {},
    ...options,
  });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-lock-recovery-"));
  lockDir = resolveGatewayLockDir({ openclawDir: root });
  fs.mkdirSync(lockDir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("recovering the state locks of a gateway that died in another container (OpenClaw 2026.11.5)", () => {
  it("keeps the lock dir under the state dir, as OpenClaw 2026.11.5 does", () => {
    expect(resolveGatewayLockDir({ openclawDir: "/data/.openclaw", uid: 1000 })).toBe("/data/.openclaw/tmp/openclaw-1000");
  });

  it("does nothing, and runs no OpenClaw command, when no lock or owner lease exists", async () => {
    const { runCli } = cli({ holders: [] });
    await expect(run({ runCli })).resolves.toEqual({ status: "skipped", reason: "absent" });
    expect(runCli).not.toHaveBeenCalled();
  });

  it("leaves a holder in this container's own PID namespace to OpenClaw", async () => {
    writeLock("gateway.state.lock", { host: "box-b", pidNsInode: "4026532999" }, 600_000);
    const { runCli } = cli({ holders: [holderLine("box-b", "4026532999", 600)] });
    await expect(run({ runCli })).resolves.toEqual({ status: "skipped", reason: "same_namespace" });
    expect(runCli).not.toHaveBeenCalled();
  });

  it("treats the same host in another PID namespace (a restarted container) as foreign", async () => {
    writeLock("gateway.state.lock", { host: "box-b", pidNsInode: "4026531836" }, 120_000);
    const { runCli, calls } = cli({ holders: [holderLine("box-b", "4026531836", 120)] });
    await expect(run({ runCli })).resolves.toMatchObject({ status: "recovered", removed: 1 });
    expect(calls).toEqual([["gateway", "recover-lock", "--json"], ["gateway", "recover-lock", "--confirm", "f".repeat(64), "--json"]]);
  });

  it("refuses a foreign holder whose heartbeat is under 90 s when told not to wait", async () => {
    writeLock("gateway.state.lock", { host: "box-a", pidNsInode: "4026531836" }, 6_000);
    const { runCli } = cli({ holders: [holderLine("box-a", "4026531836", 6)] });
    await expect(run({ runCli, waitForHeartbeat: false })).resolves.toEqual({ status: "skipped", reason: "fresh_heartbeat" });
    expect(runCli).not.toHaveBeenCalled();
  });

  it("waits out a fresh foreign heartbeat once, then recovers the exact records OpenClaw fingerprinted", async () => {
    writeLock("gateway.state.lock", { host: "box-a", pidNsInode: "4026531836" }, 6_000);
    writeLock("state.5b2781465ed8acd9.lock", { host: "box-a", pidNsInode: "4026531836" }, 20_000);
    let clock = now;
    const sleep = vi.fn(async (ms) => { clock += ms; });
    const { runCli, calls } = cli({ holders: [holderLine("box-a", "4026531836", 91), holderLine("box-a", "4026531836", 91)] });
    await expect(run({ runCli, sleep, nowMs: () => clock })).resolves.toMatchObject({
      status: "recovered",
      removed: 2,
      holders: ["holder 132 at box-a/pid-ns 4026531836, last renewed 91 s ago", "holder 132 at box-a/pid-ns 4026531836, last renewed 91 s ago"],
    });
    expect(sleep).toHaveBeenCalledWith(85_000);
    expect(calls.at(-1)).toEqual(["gateway", "recover-lock", "--confirm", "f".repeat(64), "--json"]);
  });

  it("stops when a holder kept beating while it waited", async () => {
    writeLock("gateway.state.lock", { host: "box-a", pidNsInode: "4026531836" }, 6_000);
    const sleep = vi.fn(async () => {
      const at = new Date(now - 1_000);
      fs.utimesSync(path.join(lockDir, "gateway.state.lock"), at, at);
    });
    const { runCli } = cli({ holders: [] });
    await expect(run({ runCli, sleep })).resolves.toEqual({ status: "skipped", reason: "fresh_heartbeat" });
    expect(runCli).not.toHaveBeenCalled();
  });

  it("never confirms when OpenClaw's own inspection shows a fresh beat", async () => {
    writeLock("gateway.state.lock", { host: "box-a", pidNsInode: "4026531836" }, 120_000);
    const { runCli, calls } = cli({ holders: [holderLine("box-a", "4026531836", 3)] });
    await expect(run({ runCli })).resolves.toEqual({ status: "skipped", reason: "fresh_heartbeat" });
    expect(calls).toEqual([["gateway", "recover-lock", "--json"]]);
  });

  it("recovers an owner lease an older OpenClaw left with no lock files and no host", async () => {
    const { runCli, calls } = cli({ holders: [holderLine(null, null, 215)] });
    await expect(run({ runCli, readLease: () => ({ status: "held" }) })).resolves.toMatchObject({ status: "recovered" });
    expect(calls).toHaveLength(2);
  });

  it("reports a refused recovery and never throws", async () => {
    writeLock("gateway.state.lock", { host: "box-a", pidNsInode: "4026531836" }, 120_000);
    const { runCli } = cli({ holders: [holderLine("box-a", "4026531836", 120)] }, { recovered: false });
    await expect(run({ runCli })).resolves.toMatchObject({ status: "failed", reason: "recover_refused" });
    const broken = vi.fn(async () => { throw new Error("spawn openclaw ENOENT"); });
    await expect(run({ runCli: broken })).resolves.toEqual({ status: "failed", reason: "error" });
  });

  it("leaves an unreadable lock file to OpenClaw", async () => {
    fs.writeFileSync(path.join(lockDir, "gateway.state.lock"), "{not json");
    const { runCli } = cli({ holders: [] });
    await expect(run({ runCli })).resolves.toEqual({ status: "skipped", reason: "unreadable" });
  });

  it("never blocks on a FIFO named like a lock file, and leaves it to OpenClaw", async () => {
    execFileSync("mkfifo", [path.join(lockDir, "gateway.state.lock")]);
    const { runCli } = cli({ holders: [] });
    await expect(run({ runCli })).resolves.toEqual({ status: "skipped", reason: "unreadable" });
    expect(runCli).not.toHaveBeenCalled();
  });

  it("does not read a lock file larger than 64 KiB, and leaves it to OpenClaw", async () => {
    writeLock("gateway.state.lock", { host: "box-a", pidNsInode: "4026531836" }, 120_000);
    fs.appendFileSync(path.join(lockDir, "gateway.state.lock"), " ".repeat(64 * 1024));
    const { runCli } = cli({ holders: [] });
    await expect(run({ runCli })).resolves.toEqual({ status: "skipped", reason: "unreadable" });
    expect(runCli).not.toHaveBeenCalled();
  });

  it("ends the heartbeat wait on an abort, including one that landed before the wait, and leaves no listener", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const started = Date.now();
    await sleepUnlessAborted(aborted.signal)(60_000);
    const live = new AbortController();
    const waiting = sleepUnlessAborted(live.signal)(60_000);
    live.abort();
    await waiting;
    expect(Date.now() - started).toBeLessThan(5_000);
    const signal = new AbortController().signal;
    const remove = vi.spyOn(signal, "removeEventListener");
    await sleepUnlessAborted(signal)(5);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
