const fs = require("fs");
const path = require("path");
const { createRestartLoopWatch, kStuckAfterMs } = require("../../lib/server/openclaw-restart-loop-watch");

// Lines exactly as OpenClaw 2026.10.7 prints them (gateway-boot-lifecycle-*.mjs,
// gateway-work-admission-*.mjs, restart-*.mjs, server-reload-managed-*.mjs).
const kBurst = "[gateway] received SIGUSR2 3 times in 5 min: another supervisor may be managing this Gateway — see `openclaw gateway status --deep`";
const kFence = "[admission] admission closed: restart-signal fence";
const kCoalesced = "[restart] restart request coalesced (already scheduled) reason=gateway.restart.safe pendingReason=unspecified delayMs=0 actor=<unknown>";
const kReloadCoalesced = "[reload] gateway restart already scheduled; skipping duplicate signal";

describe("server/openclaw-restart-loop-watch", () => {
  let clock;
  let notify;
  let insertEvent;
  let watch;
  const at = (ms) => { clock = ms; };
  const cycle = () => watch.observeGatewayOutput(`${kFence}\n${kCoalesced}\n`);
  beforeEach(() => {
    clock = Date.parse("2026-10-24T22:46:00.000Z");
    notify = vi.fn(async () => ({ ok: true }));
    insertEvent = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    watch = createRestartLoopWatch({ notify, insertEvent, now: () => clock });
  });
  afterEach(() => vi.restoreAllMocks());

  const runLoop = (minutes, start = clock) => {
    for (let minute = 0; minute <= minutes; minute += 1) {
      at(start + minute * 60_000);
      cycle();
    }
  };

  it("raises one event and one notice after 10 minutes of restart-loop lines, never more", async () => {
    runLoop(9);
    expect(insertEvent).not.toHaveBeenCalled();
    runLoop(30, clock + 60_000);
    watch.observeGatewayOutput(`${kBurst}\n`);
    await Promise.resolve();
    await Promise.resolve();
    expect(insertEvent).toHaveBeenCalledTimes(1);
    expect(insertEvent.mock.calls[0][0]).toMatchObject({
      eventType: "gateway_restart_loop",
      source: "restart_loop_watch",
      status: "stuck",
      details: { firstAt: "2026-10-24T22:46:00.000Z", kinds: { fence: expect.any(Number), coalesced: expect.any(Number) } },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message).toContain("A gateway restart OpenClaw scheduled has not completed");
    expect(message).toContain("Since 22:46 UTC (about 10 minutes)");
    expect(message).toContain("use Restart on the Watchdog tab");
    expect(opts).toEqual({ eventType: "restart_loop", id: `restart-loop-${Date.parse("2026-10-24T22:46:00.000Z")}` });
  });

  it("counts every line shape, including chunks split mid-line", () => {
    watch.observeGatewayOutput(kBurst.slice(0, 20));
    watch.observeGatewayOutput(`${kBurst.slice(20)}\n${kReloadCoalesced}\n`);
    expect(watch.getEpisode()).toMatchObject({ lines: 2, kinds: { signal_burst: 1, coalesced: 1 } });
  });

  it("does not fire for a short burst, too few lines, or a loop with a quiet gap", () => {
    runLoop(5);
    at(clock + 6 * 60_000);
    cycle();
    expect(watch.getEpisode().lines).toBe(2);
    at(clock + kStuckAfterMs);
    watch.observeGatewayOutput(`${kFence}\n`);
    expect(insertEvent).not.toHaveBeenCalled();
  });

  it("ignores lines during AlphaClaw's own restart until the next launch, and a launch resets the episode", () => {
    runLoop(5);
    watch.onRestartRequested();
    runLoop(20, clock + 60_000);
    expect(watch.getEpisode()).toBeNull();
    watch.onGatewayLaunch();
    runLoop(9, clock + 60_000);
    watch.onGatewayLaunch();
    expect(watch.getEpisode()).toBeNull();
    expect(insertEvent).not.toHaveBeenCalled();
  });

  it("resumes after a restart request that never launches", () => {
    watch.onRestartRequested();
    runLoop(10, clock + 31 * 60_000);
    expect(insertEvent).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated output and never throws on a failing sink", () => {
    insertEvent.mockImplementation(() => { throw new Error("db down"); });
    notify.mockImplementation(async () => { throw new Error("offline"); });
    watch.observeGatewayOutput("[gateway] http server listening (12 plugins; 3.1s)\n[restart] restart requested\n");
    expect(watch.getEpisode()).toBeNull();
    expect(() => runLoop(12)).not.toThrow();
  });
});

describe("lib/server.js wires the restart-loop watch", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "../../lib/server.js"), "utf8");
  it("feeds it the gateway output, AlphaClaw's restart requests and every launch, with the outbox notifier", () => {
    expect(serverSource).toMatch(/createRestartLoopWatch\(\{\s+notify: \(message, opts\) => upgradeNotifier\.notify\(message, opts\),\s+insertEvent: insertWatchdogEvent,/);
    expect(serverSource).toMatch(/setGatewayRestartRequestedHandler\(\(payload\) => \{\s+restartLoopWatch\.onRestartRequested\(\);/);
    expect(serverSource).toMatch(/restartRequiredLaunchClear\.onGatewayLaunch\(payload\);\s+restartLoopWatch\.onGatewayLaunch\(\);/);
    expect(serverSource).toMatch(/sessionWedgeSweep\.observeGatewayOutput\(text\);\s+restartLoopWatch\.observeGatewayOutput\(text\);/);
  });
});
