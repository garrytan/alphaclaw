const { spawn } = require("child_process");
const { findStaleEnvProcesses } = require("../../lib/server/env-stale-processes");

const kLinux = process.platform === "linux";
const suffix = `${process.pid}_${Date.now()}`;
const kChanged = `ALPH_STALE_CHANGED_${suffix}`;
const kDeleted = `ALPH_STALE_DELETED_${suffix}`;
const kAdded = `ALPH_STALE_ADDED_${suffix}`;
const kOldValue = "old-synthetic-value-1";
const kNewValue = "new-synthetic-value-2";

const children = [];
const startSleeper = (extraEnv) => {
  const child = spawn("sleep", ["60"], { env: { PATH: process.env.PATH, ...extraEnv }, stdio: "ignore" });
  children.push(child);
  return child.pid;
};

afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
});

describe.runIf(kLinux)("findStaleEnvProcesses (real /proc)", () => {
  it("lists a process that still holds the old value, by pid and command, with no value in the result", async () => {
    const stalePid = startSleeper({ [kChanged]: kOldValue });
    const currentPid = startSleeper({ [kChanged]: kNewValue });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = findStaleEnvProcesses({
      keys: [kChanged],
      envFileValues: new Map([[kChanged, kNewValue]]),
    });

    expect(result.available).toBe(true);
    expect(result.scannedProcesses).toBeGreaterThan(0);
    const entry = result.stale.find((row) => row.key === kChanged);
    expect(entry.processes).toEqual([{ pid: stalePid, command: "sleep", gateway: false, state: "differs" }]);
    expect(entry.processes.some((row) => row.pid === currentPid)).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(kOldValue);
    expect(serialized).not.toContain(kNewValue);
  });

  it("reports a deleted key a process still has as still_set", async () => {
    const pid = startSleeper({ [kDeleted]: kOldValue });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = findStaleEnvProcesses({ keys: [kDeleted], envFileValues: new Map() });

    expect(result.stale).toEqual([
      { key: kDeleted, processes: [{ pid, command: "sleep", gateway: false, state: "still_set" }] },
    ]);
  });

  it("judges the gateway tree against the launch env and reports a key it lacks as missing", async () => {
    const gatewayPid = startSleeper({});
    const otherPid = startSleeper({});
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = findStaleEnvProcesses({
      keys: [kAdded],
      envFileValues: new Map([[kAdded, kNewValue]]),
      gatewayEnv: { [kAdded]: kNewValue },
      getGatewayRootPid: () => gatewayPid,
    });

    const processes = result.stale.find((row) => row.key === kAdded).processes;
    expect(processes).toEqual([{ pid: gatewayPid, command: "sleep", gateway: true, state: "missing" }]);
    expect(processes.some((row) => row.pid === otherPid)).toBe(false);
  });

  it("does not report a gateway process missing a key the launch env strips", async () => {
    const gatewayPid = startSleeper({});
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = findStaleEnvProcesses({
      keys: [kAdded],
      envFileValues: new Map([[kAdded, kNewValue]]),
      gatewayEnv: {},
      getGatewayRootPid: () => gatewayPid,
    });

    expect(result.stale).toEqual([]);
  });

  it("skips its own process, whose env reloadEnv updates in place", () => {
    process.env[kChanged] = kOldValue;
    try {
      const result = findStaleEnvProcesses({ keys: [kChanged], envFileValues: new Map([[kChanged, kNewValue]]) });
      const pids = (result.stale.find((row) => row.key === kChanged)?.processes || []).map((row) => row.pid);
      expect(pids).not.toContain(process.pid);
    } finally {
      delete process.env[kChanged];
    }
  });
});

describe("findStaleEnvProcesses (no /proc)", () => {
  it("answers available:false when /proc cannot be listed", () => {
    const fsModule = { readdirSync: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } };
    const result = findStaleEnvProcesses({ keys: ["A"], envFileValues: new Map(), fsModule });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("no_proc");
  });

  it("checks nothing for an empty key list", () => {
    expect(findStaleEnvProcesses({ keys: [], envFileValues: new Map() })).toEqual({
      available: true,
      checkedKeys: 0,
      scannedProcesses: 0,
      unreadableProcesses: 0,
      stale: [],
    });
  });
});
