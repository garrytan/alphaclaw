import { describe, expect, it } from "vitest";
import {
  createConnectionMonitor,
  kBackoffBaseMs,
  kBackoffMaxMs,
  kHelloTimeoutMs,
  kOfflineBudgetMs,
  kStaleAfterMs,
} from "../../lib/public/js/components/chat/connection.js";

const createHarness = ({ random = () => 0.5 } = {}) => {
  const clock = { now: 0 };
  const monitor = createConnectionMonitor({ now: () => clock.now, random });
  return { clock, monitor };
};

describe("frontend/chat connection monitor", () => {
  it("backoff: base*2^attempts capped at kBackoffMaxMs with the injected jitter", () => {
    const { monitor } = createHarness();

    // random = 0.5 → jitter factor 0.7 + 0.6 * 0.5 = 1.0.
    expect(monitor.getAttempts()).toBe(0);
    expect(monitor.nextDelayMs()).toBe(kBackoffBaseMs);

    monitor.recordClose();
    expect(monitor.getAttempts()).toBe(1);
    expect(monitor.nextDelayMs()).toBe(kBackoffBaseMs * 2);

    monitor.recordClose();
    expect(monitor.getAttempts()).toBe(2);
    expect(monitor.nextDelayMs()).toBe(kBackoffBaseMs * 4);

    monitor.recordClose();
    monitor.recordClose();
    expect(monitor.getAttempts()).toBe(4);
    // 1000 * 2^4 = 16000 → capped at 15000.
    expect(monitor.nextDelayMs()).toBe(kBackoffMaxMs);

    monitor.recordClose();
    expect(monitor.nextDelayMs()).toBe(kBackoffMaxMs);

    // A successful open resets attempts and mode.
    monitor.recordOpen();
    expect(monitor.getAttempts()).toBe(0);
    expect(monitor.getMode()).toBe("online");
    expect(monitor.nextDelayMs()).toBe(kBackoffBaseMs);
  });

  it("backoff jitter respects the injected random across its full range", () => {
    // random = 0 → factor 0.7; random = 1 → factor 1.3.
    const low = createHarness({ random: () => 0 }).monitor;
    expect(low.nextDelayMs()).toBe(Math.round(kBackoffBaseMs * 0.7));

    const high = createHarness({ random: () => 1 }).monitor;
    expect(high.nextDelayMs()).toBe(Math.round(kBackoffBaseMs * 1.3));
  });

  it("offline escalation: closes past the outage budget escalate; retryNow resets", () => {
    const { clock, monitor } = createHarness();

    monitor.recordClose();
    expect(monitor.getMode()).toBe("reconnecting");

    // Inside the budget: still reconnecting.
    clock.now = kOfflineBudgetMs - 1;
    monitor.recordClose();
    expect(monitor.getMode()).toBe("reconnecting");

    // Budget exhausted: offline (visible Retry-now affordance).
    clock.now = kOfflineBudgetMs;
    monitor.recordClose();
    expect(monitor.getMode()).toBe("offline");
    expect(monitor.getAttempts()).toBe(3);

    // Manual retry: back to reconnecting with a fresh budget and attempts.
    monitor.retryNow();
    expect(monitor.getMode()).toBe("reconnecting");
    expect(monitor.getAttempts()).toBe(0);

    // The budget restarted at retryNow: the next close within it stays
    // reconnecting instead of snapping straight back to offline.
    clock.now += kOfflineBudgetMs - 1;
    monitor.recordClose();
    expect(monitor.getMode()).toBe("reconnecting");
  });

  it("legacy detection: no hello within kHelloTimeoutMs degrades to legacy; hello recovers", () => {
    const { clock, monitor } = createHarness();

    clock.now = 1_000;
    monitor.recordOpen();
    expect(monitor.getMode()).toBe("online");
    expect(monitor.isLegacy()).toBe(false);

    // Before the window elapses: not legacy.
    clock.now = 1_000 + kHelloTimeoutMs - 1;
    expect(monitor.checkHelloTimeout()).toBe(false);
    expect(monitor.getMode()).toBe("online");

    // Window elapsed with no hello: legacy server.
    clock.now = 1_000 + kHelloTimeoutMs;
    expect(monitor.checkHelloTimeout()).toBe(true);
    expect(monitor.getMode()).toBe("legacy");
    expect(monitor.isLegacy()).toBe(true);

    // A late hello (e.g. slow proxy) restores full protocol mode.
    monitor.recordHello();
    expect(monitor.getMode()).toBe("online");
    expect(monitor.isLegacy()).toBe(false);
  });

  it("legacy detection allow-legit twin: a prompt hello keeps the monitor online", () => {
    const { clock, monitor } = createHarness();

    clock.now = 1_000;
    monitor.recordOpen();
    monitor.recordHello();

    // Even long after the hello window, a hello'd socket is never legacy.
    clock.now = 1_000 + kHelloTimeoutMs * 10;
    expect(monitor.checkHelloTimeout()).toBe(false);
    expect(monitor.getMode()).toBe("online");
    expect(monitor.isLegacy()).toBe(false);
  });

  it("staleness: no frame for kStaleAfterMs marks the socket stale; a frame refreshes", () => {
    const { clock, monitor } = createHarness();

    clock.now = 5_000;
    monitor.recordOpen();
    monitor.recordFrame();
    expect(monitor.isStale()).toBe(false);

    clock.now = 5_000 + kStaleAfterMs - 1;
    expect(monitor.isStale()).toBe(false);

    clock.now = 5_000 + kStaleAfterMs;
    expect(monitor.isStale()).toBe(true);

    // Any frame (including pong) refreshes liveness.
    monitor.recordFrame();
    expect(monitor.isStale()).toBe(false);

    clock.now += kStaleAfterMs;
    expect(monitor.isStale()).toBe(true);
  });

  it("MW5: httpFallback is sticky against close/connecting and cleared by leave + open", () => {
    const { clock, monitor } = createHarness();

    monitor.enterHttpFallback();
    expect(monitor.getMode()).toBe("httpFallback");

    // While in fallback, socket lifecycle noise must not change the mode.
    monitor.recordClose();
    expect(monitor.getMode()).toBe("httpFallback");
    monitor.recordConnecting();
    expect(monitor.getMode()).toBe("httpFallback");
    clock.now = kOfflineBudgetMs * 2;
    monitor.recordClose();
    expect(monitor.getMode()).toBe("httpFallback");
    monitor.retryNow();
    expect(monitor.getMode()).toBe("httpFallback");

    // Leaving fallback resumes the reconnect loop...
    monitor.leaveHttpFallback();
    expect(monitor.getMode()).toBe("reconnecting");
    monitor.retryNow();
    expect(monitor.getMode()).toBe("reconnecting");
    expect(monitor.getAttempts()).toBe(0);

    // ...and a successful open fully clears it back to online.
    monitor.recordOpen();
    expect(monitor.getMode()).toBe("online");
    expect(monitor.getAttempts()).toBe(0);

    // Fallback fully cleared: a later close falls back to the normal
    // reconnect policy, not httpFallback.
    monitor.recordClose();
    expect(monitor.getMode()).toBe("reconnecting");
  });
});
