import { describe, expect, it } from "vitest";
import {
  buildDegradedSignals,
  WatchdogDegradedCard,
} from "../../lib/public/js/components/watchdog-tab/degraded-card.js";

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (typeof node.type === "function") {
      try {
        collectText(node.type(node.props || {}), out);
      } catch {}
    }
    collectText(node.props?.children, out);
  }
  return out;
};

const renderText = (props) => collectText(WatchdogDegradedCard(props)).join(" ");

describe("frontend/watchdog degraded card (D16)", () => {
  it("returns no signals (and renders nothing) when healthy", () => {
    expect(buildDegradedSignals(null)).toEqual([]);
    expect(
      buildDegradedSignals({ eventLoopDegraded: false, readyzFailing: [] }),
    ).toEqual([]);
    expect(
      WatchdogDegradedCard({
        watchdogStatus: { eventLoopDegraded: false, readyzFailing: [] },
      }),
    ).toBeNull();
  });

  it("gives the wedged event loop an action model that never suggests restart", () => {
    const [signal] = buildDegradedSignals({
      eventLoopDegraded: true,
      readyzFailing: [],
    });
    expect(signal.title).toContain("running but responding slowly");
    expect(signal.impact).toContain("may lag");
    expect(signal.action).toContain("restart doesn't help");
  });

  it("maps known readyz components to impact + recommended action", () => {
    const signals = buildDegradedSignals({
      eventLoopDegraded: false,
      readyzFailing: ["secrets", "mystery-subsystem"],
    });
    expect(signals).toHaveLength(2);
    expect(signals[0].title).toContain("secrets couldn't load");
    expect(signals[0].action).toContain("Secrets");
    // Unknown components still get the full model, generically worded.
    expect(signals[1].title).toContain("mystery-subsystem");
    expect(signals[1].action).toContain("gateway log");
  });

  it("renders the DEGRADED badge, rows, and last-checked stamp", () => {
    const text = renderText({
      watchdogStatus: {
        eventLoopDegraded: true,
        readyzFailing: ["secrets"],
        lastHealthCheckAt: "2026-08-28T00:00:00.000Z",
      },
    });
    expect(text).toContain("DEGRADED");
    expect(text).toContain("running but responding slowly");
    expect(text).toContain("secrets couldn't load");
    expect(text).toContain("last checked");
  });
});
