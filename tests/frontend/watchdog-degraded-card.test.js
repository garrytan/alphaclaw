import { describe, expect, it } from "vitest";
import {
  buildDegradedSignals,
  classifyReadinessCard,
  kDegradedSignalKinds,
  kReadinessCardVerdicts,
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
  // ── #87 G5: the card keys on the readiness VERDICT ─────────────────────
  const kLastChecked = "2026-08-28T00:00:00.000Z";
  const statusWith = (fields) => ({
    eventLoopDegraded: false,
    readyzFailing: [],
    readinessStatus: null,
    readinessReason: null,
    readinessProbe: "ok",
    lastHealthCheckAt: kLastChecked,
    ...fields,
  });

  it("#87 G5 classifyReadinessCard: legacy (no readiness field) · degraded · transitional (reason = status) · expired transitional is degraded · ready · unknown", () => {
    expect(kReadinessCardVerdicts).toEqual({
      degraded: "degraded",
      transitional: "transitional",
      ready: "ready",
      unknown: "unknown",
      legacy: "legacy",
    });
    expect(classifyReadinessCard(null)).toMatchObject({ verdict: "legacy", failing: [] });
    expect(
      classifyReadinessCard({ eventLoopDegraded: false, readyzFailing: ["secrets"] }),
    ).toMatchObject({ verdict: "legacy", failing: ["secrets"] });
    expect(
      classifyReadinessCard(statusWith({ readiness: "not_ready", readinessReason: "secrets", readyzFailing: ["secrets"], readinessStatus: "started" })),
    ).toMatchObject({ verdict: "degraded", failing: ["secrets"], reason: "secrets" });
    expect(
      classifyReadinessCard(statusWith({ readiness: "not_ready", readinessReason: "ready:false" })),
    ).toMatchObject({ verdict: "degraded", failing: [], reason: "ready:false" });
    for (const status of ["starting", "draining"]) {
      expect(
        classifyReadinessCard(statusWith({ readiness: "not_ready", readinessReason: status, readinessStatus: status })),
      ).toMatchObject({ verdict: "transitional", reason: status });
    }
    // The X2 expiry writes a longer reason: a real not-ready, not transitional.
    expect(
      classifyReadinessCard(
        statusWith({ readiness: "not_ready", readinessStatus: "starting", readinessReason: "starting did not complete within 300s" }),
      ),
    ).toMatchObject({ verdict: "degraded", reason: "starting did not complete within 300s" });
    expect(
      classifyReadinessCard(statusWith({ readiness: "ready", readyzFailing: ["secrets"], readinessStatus: "starting" })),
    ).toMatchObject({ verdict: "ready", failing: ["secrets"], reason: null });
    expect(
      classifyReadinessCard(statusWith({ readiness: "unknown", readinessProbe: "timeout", readyzFailing: ["secrets"] })),
    ).toMatchObject({ verdict: "unknown", failing: ["secrets"], probe: "timeout" });
    // Gateway-controlled list entries that are not strings are dropped.
    expect(
      classifyReadinessCard(statusWith({ readiness: "ready", readyzFailing: ["secrets", 3, null] })),
    ).toMatchObject({ failing: ["secrets"] });
  });

  it("#87 G5 (a) not_ready without components: ONE generic degraded signal built from readinessReason, DEGRADED badge", () => {
    const props = {
      watchdogStatus: statusWith({ readiness: "not_ready", readinessReason: "ready:false" }),
    };
    const signals = buildDegradedSignals(props.watchdogStatus);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ key: "readiness", kind: "degraded" });
    expect(signals[0].title).toBe("OpenClaw reports the gateway not ready");
    expect(signals[0].impact).toContain("ready:false");
    expect(signals[0].action).toBe("Check the gateway log below; the check re-runs automatically.");
    expect(renderBadges(props)).toEqual([{ tone: "warning", text: "DEGRADED" }]);
    const text = renderText(props);
    expect(text).toContain("OpenClaw reports the gateway not ready");
    expect(text).toContain("ready:false");
    expect(text).not.toContain("LOAD");
    expect(text).not.toContain("Reported by /readyz");
    // With components the rows are the components, no generic signal.
    const withComponents = buildDegradedSignals(
      statusWith({ readiness: "not_ready", readinessReason: "secrets", readyzFailing: ["secrets"] }),
    );
    expect(withComponents.map((signal) => signal.key)).toEqual(["readyz-secrets"]);
  });

  it("#87 G5 (a) transitional (starting/draining inside the budget): NO card from readiness — null without pressure, pressure alone renders LOAD only", () => {
    for (const status of ["starting", "draining"]) {
      const transitional = statusWith({ readiness: "not_ready", readinessReason: status, readinessStatus: status });
      expect(buildDegradedSignals(transitional)).toEqual([]);
      expect(WatchdogDegradedCard({ watchdogStatus: transitional })).toBeNull();
      // Components retained beside a transitional body are not a card either.
      expect(
        WatchdogDegradedCard({ watchdogStatus: { ...transitional, readyzFailing: ["channels"] } }),
      ).toBeNull();
    }
    const props = {
      watchdogStatus: statusWith({
        readiness: "not_ready",
        readinessReason: "starting",
        readinessStatus: "starting",
        eventLoopDegraded: true,
      }),
    };
    expect(renderBadges(props)).toEqual([{ tone: "neutral", text: "LOAD" }]);
    const text = renderText(props);
    expect(text).not.toContain("DEGRADED");
    expect(text).toContain("running but responding slowly");
    // The expired phase IS degraded (the X2 verdict).
    const expired = {
      watchdogStatus: statusWith({
        readiness: "not_ready",
        readinessStatus: "starting",
        readinessReason: "starting did not complete within 300s",
      }),
    };
    expect(renderBadges(expired)).toEqual([{ tone: "warning", text: "DEGRADED" }]);
    expect(renderText(expired)).toContain("starting did not complete within 300s");
  });

  it("#87 G5 (b) ready:true with a non-empty readyzFailing: NOT degraded — neutral TELEMETRY treatment, 'OpenClaw reports it ready', components listed under 'Reported by /readyz (telemetry)'", () => {
    const props = {
      watchdogStatus: statusWith({ readiness: "ready", readyzFailing: ["secrets", "mystery-subsystem"] }),
    };
    expect(buildDegradedSignals(props.watchdogStatus)).toEqual([]);
    expect(renderBadges(props)).toEqual([{ tone: "neutral", text: "TELEMETRY" }]);
    const text = renderText(props);
    expect(text).not.toContain("DEGRADED");
    expect(text).toContain("OpenClaw reports it ready");
    expect(text).toContain("Reported by /readyz (telemetry)");
    expect(text).toContain("secrets");
    expect(text).toContain("mystery-subsystem");
    // The action model of the component rows is NOT shown: ready wins.
    expect(text).not.toContain("secrets couldn't load");
    expect(text).toContain("last checked");
    // Ready + pressure + components: LOAD badge, both telemetry lists, pressure under its label.
    const loaded = {
      watchdogStatus: statusWith({ readiness: "ready", readyzFailing: ["secrets"], eventLoopDegraded: true }),
    };
    expect(renderBadges(loaded)).toEqual([{ tone: "neutral", text: "LOAD" }]);
    const loadedText = renderText(loaded);
    expect(loadedText).toContain("healthy but under load — OpenClaw reports it ready");
    expect(loadedText).toContain("Load (telemetry)");
    expect(loadedText).toContain("Reported by /readyz (telemetry)");
    // Ready with nothing retained: no card.
    expect(WatchdogDegradedCard({ watchdogStatus: statusWith({ readiness: "ready" }) })).toBeNull();
  });

  it("#87 G5 (c) readiness unknown (fail-open / unsupported / unconfigured): the retained readyzFailing is stale — no DEGRADED badge, neutral list with 'readiness unverified (<readinessProbe>)'; nothing retained → no card", () => {
    const props = {
      watchdogStatus: statusWith({ readiness: "unknown", readinessProbe: "timeout", readyzFailing: ["secrets"] }),
    };
    expect(buildDegradedSignals(props.watchdogStatus)).toEqual([]);
    expect(renderBadges(props)).toEqual([{ tone: "neutral", text: "TELEMETRY" }]);
    const text = renderText(props);
    expect(text).not.toContain("DEGRADED");
    expect(text).toContain("readiness unverified (timeout)");
    expect(text).not.toContain("OpenClaw reports it ready");
    expect(text).toContain("Reported by /readyz (telemetry)");
    expect(text).toContain("secrets");
    expect(
      renderText({
        watchdogStatus: statusWith({ readiness: "unknown", readinessProbe: "unsupported", readyzFailing: ["secrets"] }),
      }),
    ).toContain("readiness unverified (unsupported)");
    expect(
      renderText({ watchdogStatus: statusWith({ readiness: "unknown", readinessProbe: null, readyzFailing: ["secrets"] }) }),
    ).toContain("readiness unverified (unknown)");
    expect(
      WatchdogDegradedCard({ watchdogStatus: statusWith({ readiness: "unknown", readinessProbe: "unconfigured" }) }),
    ).toBeNull();
  });

  it("#87 G5 (d) legacy status objects without a readiness field keep today's behavior: failing components degrade", () => {
    const props = {
      watchdogStatus: { eventLoopDegraded: false, readyzFailing: ["secrets"], lastHealthCheckAt: kLastChecked },
    };
    expect(classifyReadinessCard(props.watchdogStatus).verdict).toBe("legacy");
    expect(buildDegradedSignals(props.watchdogStatus).map((signal) => [signal.key, signal.kind])).toEqual([
      ["readyz-secrets", "degraded"],
    ]);
    expect(renderBadges(props)).toEqual([{ tone: "warning", text: "DEGRADED" }]);
    expect(renderText(props)).not.toContain("Reported by /readyz");
  });
});
