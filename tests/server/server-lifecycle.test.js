const http = require("http");
const { EventEmitter } = require("events");
const {
  createServerLifecycle,
} = require("../../lib/server/init/server-lifecycle");

// NOTE: installCrashGuards() is intentionally never called here — it would
// removeAllListeners() for unhandledRejection/uncaughtException/SIGTERM/SIGINT
// and clobber vitest's own handlers. The exported pieces are tested with
// injected fakes instead.

const createSilentLogger = () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const listenOnEphemeralPort = (server) =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

const closeIfListening = (server) =>
  new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });

describe("server/init/server-lifecycle", () => {
  const openServers = [];
  const trackServer = (server) => {
    openServers.push(server);
    return server;
  };

  afterEach(async () => {
    while (openServers.length > 0) {
      await closeIfListening(openServers.pop());
    }
  });

  it("drains shutdown steps in order and exits with the requested code", async () => {
    const server = trackServer(http.createServer((_req, res) => res.end("ok")));
    const order = [];
    const exitCalls = [];
    const logger = createSilentLogger();
    const lifecycle = createServerLifecycle({
      server,
      PORT: 0,
      isOnboarded: () => false,
      runOnboardedBootSequence: vi.fn(),
      stopGateway: vi.fn(async () => {
        order.push("gateway");
      }),
      stopWatchdog: vi.fn(() => {
        order.push("watchdog");
      }),
      gmailWatchService: {
        stop: vi.fn(async () => {
          order.push("gmail");
        }),
      },
      watchdogTerminal: {
        disposeSession: vi.fn(() => {
          order.push("terminal");
        }),
      },
      disposeServices: vi.fn(() => {
        order.push("dispose");
      }),
      flushLogs: vi.fn(() => {
        order.push("flush");
      }),
      exitImpl: (code) => exitCalls.push(code),
      logger,
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 200,
    });

    lifecycle.startListening();
    await new Promise((resolve) => server.on("listening", resolve));
    expect(server.listening).toBe(true);
    expect(
      logger.log.mock.calls.some((call) =>
        String(call[0]).includes("Express listening"),
      ),
    ).toBe(true);
    expect(
      logger.log.mock.calls.some((call) =>
        String(call[0]).includes("Awaiting onboarding"),
      ),
    ).toBe(true);

    await lifecycle.gracefulExit(0, "test shutdown");

    // watchdog stop (before gateway stop, so probes don't react to the
    // expected exit) → gateway stop → gmail watch stop → terminal dispose →
    // service dispose → log flush, then exit with the requested code. The
    // http terminator ran between watchdog and gateway and closed the server.
    expect(order).toEqual(["watchdog", "gateway", "gmail", "terminal", "dispose", "flush"]);
    expect(exitCalls).toEqual([0]);
    expect(server.listening).toBe(false);
  });

  it("pins keep-alive, headers, and request timeouts on the server", () => {
    const server = trackServer(http.createServer(() => {}));
    createServerLifecycle({
      server,
      PORT: 0,
      exitImpl: vi.fn(),
      logger: createSilentLogger(),
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 200,
    });

    // keepAliveTimeout must outlive a platform LB's ~60s idle timeout,
    // headersTimeout must exceed keepAliveTimeout, and requestTimeout pins
    // Node's default explicitly.
    expect(server.keepAliveTimeout).toBe(65000);
    expect(server.headersTimeout).toBe(66000);
    expect(server.requestTimeout).toBe(300000);
  });

  it("a throwing disposeServices step is logged and does not prevent the log flush", async () => {
    const order = [];
    const logger = createSilentLogger();
    const lifecycle = createServerLifecycle({
      server: new EventEmitter(),
      PORT: 3999,
      stopGateway: vi.fn(async () => {
        order.push("gateway");
      }),
      disposeServices: vi.fn(() => {
        order.push("dispose");
        throw new Error("dispose exploded");
      }),
      flushLogs: vi.fn(() => {
        order.push("flush");
      }),
      exitImpl: vi.fn(),
      logger,
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 200,
    });

    await lifecycle.drain();

    expect(order).toEqual(["gateway", "dispose", "flush"]);
    expect(logger.error).toHaveBeenCalledWith(
      "[alphaclaw] shutdown step failed (service dispose): dispose exploded",
    );
  });

  it("catches a rejecting boot sequence instead of feeding the storm brake", async () => {
    const server = trackServer(http.createServer(() => {}));
    const logger = createSilentLogger();
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    const lifecycle = createServerLifecycle({
      server,
      PORT: 0,
      isOnboarded: () => true,
      runOnboardedBootSequence: async () => {
        throw new Error("boot exploded");
      },
      exitImpl: vi.fn(),
      logger,
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 200,
    });

    lifecycle.startListening();
    await new Promise((resolve) => server.on("listening", resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).not.toHaveBeenCalled();
    expect(
      logger.error.mock.calls.some((call) =>
        String(call[0]).includes("Boot sequence error: boot exploded"),
      ),
    ).toBe(true);
    process.removeListener("unhandledRejection", unhandled);
  });

  it("runs the onboarded boot sequence on listen when onboarded", async () => {
    const server = trackServer(http.createServer(() => {}));
    const runOnboardedBootSequence = vi.fn();
    const exitCalls = [];
    const lifecycle = createServerLifecycle({
      server,
      PORT: 0,
      isOnboarded: () => true,
      runOnboardedBootSequence,
      exitImpl: (code) => exitCalls.push(code),
      logger: createSilentLogger(),
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 200,
    });

    lifecycle.startListening();
    await new Promise((resolve) => server.on("listening", resolve));

    expect(runOnboardedBootSequence).toHaveBeenCalledTimes(1);
    expect(exitCalls).toEqual([]);
  });

  it("a second gracefulExit while draining exits immediately without re-draining", async () => {
    let releaseStop;
    const stopGateway = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseStop = resolve;
        }),
    );
    const exitCalls = [];
    const lifecycle = createServerLifecycle({
      server: new EventEmitter(),
      PORT: 3999,
      stopGateway,
      flushLogs: vi.fn(),
      exitImpl: (code) => exitCalls.push(code),
      logger: createSilentLogger(),
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 5000,
    });

    const first = lifecycle.gracefulExit(0, "first");
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopGateway).toHaveBeenCalledTimes(1);

    // Re-entrant shutdown while draining exits immediately without
    // re-running the drain. A benign duplicate SIGTERM (code 0) keeps the
    // ORIGINAL exit code — it must not flip a clean shutdown into failure.
    await lifecycle.gracefulExit(0, "second");
    expect(exitCalls).toEqual([0]);
    expect(stopGateway).toHaveBeenCalledTimes(1);

    // A re-entrant FAILURE keeps its failure code.
    await lifecycle.gracefulExit(1, "failure during drain");
    expect(exitCalls).toEqual([0, 1]);

    releaseStop();
    await first;
    expect(exitCalls).toEqual([0, 1, 0]);
    expect(stopGateway).toHaveBeenCalledTimes(1);
  });

  it("a signal during a marked-exiting drain exits immediately without a second drain", async () => {
    const stopGateway = vi.fn(async () => {});
    const killGatewayNow = vi.fn();
    const exitCalls = [];
    const lifecycle = createServerLifecycle({
      server: new EventEmitter(),
      PORT: 3999,
      stopGateway,
      killGatewayNow,
      flushLogs: vi.fn(),
      exitImpl: (code) => exitCalls.push(code),
      logger: createSilentLogger(),
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 5000,
    });

    // restartProcess (alphaclaw-version.js) latches the lifecycle before
    // running its own bounded drain(), so a SIGTERM landing inside that
    // window must hit the already-draining fast path: immediate exit with
    // the latched intentional-restart code, and NO second drain.
    lifecycle.markExiting(75);
    await lifecycle.gracefulExit(0, "SIGTERM");

    expect(exitCalls).toEqual([75]);
    expect(stopGateway).not.toHaveBeenCalled();
    // Last-ditch gateway reap still runs so an orphaned child can't hold the
    // port against the successor process.
    expect(killGatewayNow).toHaveBeenCalledTimes(1);

    // The latch is first-writer-wins: a later markExiting must not clobber
    // an exit code that is already committed.
    lifecycle.markExiting(0);
    await lifecycle.gracefulExit(0, "SIGTERM again");
    expect(exitCalls).toEqual([75, 75]);
    expect(stopGateway).not.toHaveBeenCalled();
  });

  it("enforces the hard shutdown deadline when a drain step hangs", async () => {
    const exitCalls = [];
    const lifecycle = createServerLifecycle({
      server: new EventEmitter(),
      PORT: 3999,
      stopGateway: () => new Promise(() => {}), // never resolves
      exitImpl: (code) => exitCalls.push(code),
      logger: createSilentLogger(),
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 200,
    });

    const startedAt = Date.now();
    void lifecycle.gracefulExit(0, "hung gateway stop");

    await vi.waitFor(() => {
      expect(exitCalls).toContain(1);
    });
    // Fired via the deadline (≈200ms), not some much later fallback.
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(exitCalls).toEqual([1]);
  });

  it("retries EADDRINUSE five times then exits(1) when the port stays occupied", async () => {
    const blocker = trackServer(http.createServer(() => {}));
    const blockedPort = await listenOnEphemeralPort(blocker);

    const server = trackServer(http.createServer(() => {}));
    const exitCalls = [];
    const logger = createSilentLogger();
    const lifecycle = createServerLifecycle({
      server,
      PORT: blockedPort,
      exitImpl: (code) => exitCalls.push(code),
      logger,
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 200,
    });

    lifecycle.startListening();

    await vi.waitFor(() => {
      expect(exitCalls).toEqual([1]);
    });
    const retryWarnings = logger.warn.mock.calls.filter((call) =>
      String(call[0]).includes("in use"),
    );
    expect(retryWarnings).toHaveLength(5);
    expect(
      logger.error.mock.calls.some((call) =>
        String(call[0]).includes(`failed to listen on :${blockedPort}`),
      ),
    ).toBe(true);
  });

  it("listens fine once the port is free", async () => {
    // Same wiring as the EADDRINUSE case, but nothing occupies the port.
    const server = trackServer(http.createServer(() => {}));
    const exitCalls = [];
    const logger = createSilentLogger();
    const lifecycle = createServerLifecycle({
      server,
      PORT: 0,
      exitImpl: (code) => exitCalls.push(code),
      logger,
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 200,
    });

    lifecycle.startListening();
    await new Promise((resolve) => server.on("listening", resolve));

    expect(server.listening).toBe(true);
    expect(exitCalls).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("exits(1) immediately on non-EADDRINUSE listen errors", async () => {
    const server = new EventEmitter();
    server.listen = vi.fn();
    const exitCalls = [];
    const logger = createSilentLogger();
    const lifecycle = createServerLifecycle({
      server,
      PORT: 4321,
      exitImpl: (code) => exitCalls.push(code),
      logger,
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 200,
    });

    lifecycle.startListening();
    const error = new Error("EACCES: permission denied");
    error.code = "EACCES";
    server.emit("error", error);

    expect(exitCalls).toEqual([1]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("triggers gracefulExit(1) after an unhandled-rejection storm", async () => {
    const order = [];
    const exitCalls = [];
    const lifecycle = createServerLifecycle({
      server: new EventEmitter(),
      PORT: 3999,
      stopGateway: vi.fn(async () => {
        order.push("gateway");
      }),
      flushLogs: vi.fn(() => {
        order.push("flush");
      }),
      exitImpl: (code) => exitCalls.push(code),
      logger: createSilentLogger(),
      listenRetryDelayMs: 1,
      shutdownDeadlineMs: 200,
      rejectionStormThreshold: 3,
      rejectionStormWindowMs: 60_000,
    });

    // Two rejections: logged and counted, but no exit.
    expect(lifecycle.__recordUnhandledRejection(new Error("boom-1"))).toBe(false);
    expect(lifecycle.__recordUnhandledRejection(new Error("boom-2"))).toBe(false);
    expect(exitCalls).toEqual([]);
    expect(lifecycle.getRejectionStats()).toEqual({ total: 2, inWindow: 2 });

    // Third within the window trips the storm breaker → bounded restart.
    expect(lifecycle.__recordUnhandledRejection(new Error("boom-3"))).toBe(true);
    await vi.waitFor(() => {
      expect(exitCalls).toEqual([1]);
    });
    expect(order).toEqual(["gateway", "flush"]);
    expect(lifecycle.getRejectionStats()).toEqual({ total: 3, inWindow: 3 });
  });

  it("two rejections alone never exit", async () => {
    const exitCalls = [];
    const lifecycle = createServerLifecycle({
      server: new EventEmitter(),
      PORT: 3999,
      exitImpl: (code) => exitCalls.push(code),
      logger: createSilentLogger(),
      shutdownDeadlineMs: 200,
      rejectionStormThreshold: 3,
      rejectionStormWindowMs: 60_000,
    });

    lifecycle.__recordUnhandledRejection(new Error("one"));
    lifecycle.__recordUnhandledRejection(new Error("two"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(exitCalls).toEqual([]);
    expect(lifecycle.getRejectionStats()).toEqual({ total: 2, inWindow: 2 });
  });
});
