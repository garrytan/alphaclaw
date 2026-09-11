import { describe, expect, it } from "vitest";
import {
  buildDegradedSignals,
  kDegradedSignalKinds,
  WatchdogDegradedCard,
} from "../../lib/public/js/components/watchdog-tab/degraded-card.js";
import { Badge } from "../../lib/public/js/components/badge.js";

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

// Every Badge vnode in the tree as { tone, text } — the tone is the contract
// the operator reads before the words ("yellow" means act, "gray" means look).
const collectBadges = (node, out = []) => {
  if (Array.isArray(node)) {
    for (const child of node) collectBadges(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (node.type === Badge) {
      out.push({
        tone: node.props?.tone,
        text: collectText(node.props?.children).join("").trim(),
      });
    } else if (typeof node.type === "function") {
      try {
        collectBadges(node.type(node.props || {}), out);
      } catch {}
    }
    collectBadges(node.props?.children, out);
  }
  return out;
};

const renderText = (props) => collectText(WatchdogDegradedCard(props)).join(" ");
const renderBadges = (props) => collectBadges(WatchdogDegradedCard(props));

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

  it("#87 pins signal kinds: event loop is pressure, readyz components are degraded", () => {
    expect(kDegradedSignalKinds).toEqual({
      degraded: "degraded",
      pressure: "pressure",
    });
    const signals = buildDegradedSignals({
      eventLoopDegraded: true,
      readyzFailing: ["secrets", "mystery-subsystem"],
    });
    expect(signals.map((signal) => [signal.key, signal.kind])).toEqual([
      ["event-loop", "pressure"],
      ["readyz-secrets", "degraded"],
      ["readyz-mystery-subsystem", "degraded"],
    ]);
    // Existing consumers keep the same keys; `kind` is purely additive.
    for (const signal of signals) {
      expect(Object.keys(signal).sort()).toEqual(
        ["action", "impact", "key", "kind", "title"],
      );
    }
  });

  it("#87 pressure only: neutral LOAD badge, healthy-under-load title, no DEGRADED wording", () => {
    const props = {
      watchdogStatus: {
        eventLoopDegraded: true,
        readyzFailing: [],
        lastHealthCheckAt: "2026-08-28T00:00:00.000Z",
      },
    };
    expect(renderBadges(props)).toEqual([{ tone: "neutral", text: "LOAD" }]);
    const text = renderText(props);
    expect(text).not.toContain("DEGRADED");
    expect(text).toContain("healthy but under load");
    expect(text).toContain("running but responding slowly");
    expect(text).toContain("restart doesn't help");
    expect(text).toContain("last checked");
    // The pressure row needs no section label when it is the only content.
    expect(text).not.toContain("Load (telemetry)");
  });

  it("#87 components only: warning DEGRADED badge, no pressure row or load label", () => {
    const props = {
      watchdogStatus: {
        eventLoopDegraded: false,
        readyzFailing: ["secrets"],
        lastHealthCheckAt: "2026-08-28T00:00:00.000Z",
      },
    };
    expect(renderBadges(props)).toEqual([{ tone: "warning", text: "DEGRADED" }]);
    const text = renderText(props);
    expect(text).toContain("secrets couldn't load");
    expect(text).toContain("last checked");
    expect(text).not.toContain("LOAD");
    expect(text).not.toContain("healthy but under load");
    expect(text).not.toContain("running but responding slowly");
  });

  it("#87 both: DEGRADED badge, component rows first, pressure row under its own small label", () => {
    const props = {
      watchdogStatus: {
        eventLoopDegraded: true,
        readyzFailing: ["secrets"],
        lastHealthCheckAt: "2026-08-28T00:00:00.000Z",
      },
    };
    expect(renderBadges(props)).toEqual([{ tone: "warning", text: "DEGRADED" }]);
    const text = renderText(props);
    expect(text).toContain("DEGRADED");
    expect(text).toContain("secrets couldn't load");
    expect(text).toContain("Load (telemetry)");
    expect(text).toContain("running but responding slowly");
    expect(text).toContain("last checked");
    expect(text).not.toContain("healthy but under load");
    // Order: component failure → load label → pressure row.
    const componentAt = text.indexOf("secrets couldn't load");
    const labelAt = text.indexOf("Load (telemetry)");
    const pressureAt = text.indexOf("running but responding slowly");
    expect(componentAt).toBeGreaterThan(-1);
    expect(labelAt).toBeGreaterThan(componentAt);
    expect(pressureAt).toBeGreaterThan(labelAt);
  });

  it("renders last-checked as a browser-local time with seconds (probes land seconds apart)", () => {
    const lastHealthCheckAt = "2026-08-28T00:00:00.000Z";
    const text = renderText({
      watchdogStatus: {
        eventLoopDegraded: true,
        readyzFailing: [],
        lastHealthCheckAt,
      },
    });
    // Same Intl preset production uses (format.js timeStyle medium), so the
    // assertion stays locale- and timezone-agnostic in CI.
    const expected = new Intl.DateTimeFormat(undefined, {
      timeStyle: "medium",
    }).format(new Date(lastHealthCheckAt));
    expect(text).toContain("last checked");
    expect(text).toContain(expected);
  });
});
