const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "node-options-signal-test-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;
fs.mkdirSync(path.join(kTempRoot, ".openclaw", ".alphaclaw"), { recursive: true });

const {
  findSignalCollisions,
  stripSignalCollisionFlags,
} = require("../../lib/server/node-options-signal-flags");
const { gatewayEnv } = require("../../lib/server/gateway");
const { stripTelemetryNodeOptions } = require("../../lib/server/gateway-memory/telemetry-bootstrap");
const { buildDeterministicCards } = require("../../lib/server/doctor/deterministic-checks");
const { analyzeBootstrapContext } = require("../../lib/server/doctor/bootstrap-context");
const { kCurrentContextProfile } = require("../../lib/server/doctor/context-profiles");

describe("server/node-options-signal-flags", () => {
  it("strips --heapsnapshot-signal on SIGUSR2 and SIGUSR1 in both spellings and keeps everything else", () => {
    expect(stripSignalCollisionFlags("--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=/srv/diag --inspect")).toEqual({
      nodeOptions: "--diagnostic-dir=/srv/diag --inspect",
      collisions: [{ flag: "--heapsnapshot-signal", signal: "SIGUSR2" }],
    });
    expect(stripSignalCollisionFlags("--trace-warnings --heapsnapshot-signal SIGUSR1").nodeOptions).toBe("--trace-warnings");
    expect(stripSignalCollisionFlags("--heapsnapshot_signal=SIGUSR2").nodeOptions).toBe("");
  });

  it("leaves a heap-snapshot signal OpenClaw does not use alone", () => {
    expect(stripSignalCollisionFlags("--heapsnapshot-signal=SIGPWR --inspect")).toEqual({
      nodeOptions: "--heapsnapshot-signal=SIGPWR --inspect",
      collisions: [],
    });
  });

  it("strips --report-on-signal when the report signal is the default SIGUSR2 or SIGUSR1, not otherwise", () => {
    expect(stripSignalCollisionFlags("--report-on-signal --report-directory=/srv/r")).toEqual({
      nodeOptions: "--report-directory=/srv/r",
      collisions: [{ flag: "--report-on-signal", signal: "SIGUSR2" }],
    });
    expect(findSignalCollisions("--report-signal=SIGUSR1 --report-on-signal")).toEqual([
      { flag: "--report-on-signal", signal: "SIGUSR1" },
    ]);
    expect(findSignalCollisions("--report-on-signal --report-signal=SIGPWR")).toEqual([]);
  });

  it("reports nothing for empty or unrelated NODE_OPTIONS", () => {
    expect(findSignalCollisions(undefined)).toEqual([]);
    expect(findSignalCollisions("--max-old-space-size=4096 --enable-source-maps")).toEqual([]);
  });

  it("the stripped NODE_OPTIONS leaves a real Node process with no SIGUSR2 listener", () => {
    const run = (nodeOptions) => String(execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.listenerCount('SIGUSR2')))"], {
      env: { PATH: process.env.PATH, NODE_OPTIONS: nodeOptions },
    }));
    const original = `--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=${kTempRoot}`;
    expect(run(original)).toBe("1");
    expect(run(stripSignalCollisionFlags(original).nodeOptions)).toBe("0");
  });
});

describe("gatewayEnv drops colliding diagnostic signal flags", () => {
  const savedNodeOptions = process.env.NODE_OPTIONS;
  afterEach(() => {
    vi.restoreAllMocks();
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
  });

  it("removes the flag from the child env only, logs names once, and never logs the diagnostic dir", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NODE_OPTIONS = "--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=/srv/private-diag --max-old-space-size=4096";
    const env = gatewayEnv();
    expect(stripTelemetryNodeOptions(env.NODE_OPTIONS)).toBe("--diagnostic-dir=/srv/private-diag");
    expect(process.env.NODE_OPTIONS).toBe("--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=/srv/private-diag --max-old-space-size=4096");
    gatewayEnv();
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("--heapsnapshot-signal"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("NODE_OPTIONS: removed --heapsnapshot-signal (SIGUSR2)");
    expect(lines[0]).not.toContain("/srv/private-diag");
  });

  it("drops NODE_OPTIONS entirely when the colliding flag was all it held", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.NODE_OPTIONS = "--report-on-signal";
    expect(stripTelemetryNodeOptions(gatewayEnv().NODE_OPTIONS || "")).toBe("");
  });
});

describe("server/doctor det:node-options-signal-collision", () => {
  let workspaceRoot;
  let managedRoot;
  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-det-signal-ws-"));
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-det-signal-managed-"));
  });
  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(managedRoot, { recursive: true, force: true });
  });
  const signalCards = (nodeOptionsSignalCollisions) =>
    buildDeterministicCards({
      workspaceRoot,
      managedRoot,
      profile: kCurrentContextProfile,
      bootstrapContext: analyzeBootstrapContext({ workspaceRoot, profile: kCurrentContextProfile }),
      onboarded: true,
      readLatestDoctorRun: () => null,
      nodeOptionsSignalCollisions,
    }).filter((card) => String(card.sourceKey).startsWith("det:node-options-signal-collision"));

  it("emits one P1 config card naming the flag and signal", () => {
    const cards = signalCards(findSignalCollisions("--heapsnapshot-signal=SIGUSR2 --diagnostic-dir=/srv/private-diag"));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      sourceKey: "det:node-options-signal-collision:heapsnapshot-signal-SIGUSR2",
      priority: "P1",
      category: "config",
      status: "open",
      source: "deterministic",
    });
    expect(cards[0].summary).toContain("--heapsnapshot-signal (SIGUSR2)");
    expect(cards[0].summary).toContain("AlphaClaw removes the flag from the gateway's environment");
    expect(JSON.stringify(cards[0])).not.toContain("/srv/private-diag");
    expect(cards[0].fixPrompt).toMatch(/^Do not edit workspace files/);
  });

  it("emits nothing without a collision", () => {
    expect(signalCards([])).toEqual([]);
    expect(signalCards(undefined)).toEqual([]);
    expect(signalCards([{ flag: "--inspect", signal: "SIGUSR2" }])).toEqual([]);
  });
});
