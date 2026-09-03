import { beforeEach, describe, expect, it, vi } from "vitest";

// Hook harness (team-tab-component.test.js pattern): the card renders without
// a DOM; useNowMs's state/effect land in per-call-index slots.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, effects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
    harness.effects = [];
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.effects = [];
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] =
        typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (next) => {
      harness.slots[index] =
        typeof next === "function" ? next(harness.slots[index]) : next;
    };
    return [harness.slots[index], setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { current: initialValue };
    }
    return harness.slots[index];
  };
  const useMemo = (factory) => factory();
  const useCallback = (fn) => fn;
  const useEffect = (effect) => {
    harness.effects.push(effect);
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

import * as preactHooks from "preact/hooks";
import {
  buildWatchdogOverseerModel,
  buildWatchdogScopeLine,
  kOverseerCardCopy,
  kOverseerVerdictBadge,
  WatchdogOverseerCard,
} from "../../lib/public/js/components/watchdog-tab/overseer-card.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { Badge } from "../../lib/public/js/components/badge.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { ToggleSwitch } from "../../lib/public/js/components/toggle-switch.js";
import { formatLocaleTime } from "../../lib/public/js/lib/format.js";

const harness = preactHooks.__harness;

const kNow = Date.parse("2026-08-29T12:00:00Z");
const min = (n) => n * 60_000;
const iso = (ms) => new Date(ms).toISOString();

const kDegraded = { health: "degraded", lifecycle: "running", phase: "degraded_retry" };
const kHealthy = { health: "healthy", lifecycle: "running", phase: "running" };

const incidentRow = (id, overrides = {}) => ({
  id,
  status: "resolved",
  openedAt: iso(kNow - min(60)),
  resolvedAt: iso(kNow - min(50)),
  eventCount: 4,
  summary: {},
  overseer: null,
  ...overrides,
});

const reviewed = (id, current, overrides = {}) =>
  incidentRow(id, { overseer: { v: 1, current }, ...overrides });

const incidentVerdict = (overrides = {}) => ({
  state: "done",
  verdict: "action_needed",
  action: "repair",
  headline: "Repairs exhausted",
  summary: "Two failed repairs.",
  recommendation: "Run Repair manually.",
  at: kNow - min(20),
  ...overrides,
});

// Default log coverage spans the whole 30-min window (no late start).
const evidence = (overrides = {}) => ({
  collectedFrom: kNow - min(5),
  collectedThrough: kNow - min(4),
  logFrom: kNow - min(35),
  logThrough: kNow - min(5),
  logLines: 412,
  logMatched: 412,
  logPartial: false,
  logFrontTruncated: false,
  doctor: "ok",
  status: { ...kDegraded, degradedSince: kNow - min(30) },
  openIncidentId: null,
  openIncidentOpenedAt: null,
  ...overrides,
});

const situationRecord = (overrides = {}) => ({
  state: "done",
  verdict: "watch",
  action: "none",
  headline: "Probes flapping",
  summary: "Two readyz failures in ten minutes.",
  recommendation: "Watch the next probe cycle.",
  manual: true,
  situation: true,
  at: kNow - min(5),
  evidence: evidence(),
  ...overrides,
});

const payload = (overrides = {}) => ({
  ok: true,
  current: null,
  lastVerdict: null,
  nextManualAt: 0,
  inFlight: false,
  ...overrides,
});

const model = (overrides = {}) =>
  buildWatchdogOverseerModel({
    incidents: [],
    situation: payload(),
    watchdogStatus: kDegraded,
    nowMs: kNow,
    ...overrides,
  });

const range = (from, to) => `${formatLocaleTime(from)}–${formatLocaleTime(to)}`;
const evidenceLineFor = (overrides = {}) =>
  model({
    situation: payload({ lastVerdict: situationRecord({ evidence: evidence(overrides) }) }),
  }).situationReport.evidenceLine;

describe("buildWatchdogOverseerModel — loading, empty, badge map", () => {
  it("is loading only until the first poll answers (null data AND null error)", () => {
    expect(buildWatchdogOverseerModel({ situation: null, situationError: null }).loading).toBe(true);
    expect(buildWatchdogOverseerModel({ situation: undefined }).loading).toBe(true);
    expect(model().loading).toBe(false);
    const failed = model({ situation: null, situationError: new Error("boom") });
    expect(failed.loading).toBe(false);
    expect(failed.primary).toBe(null);
  });

  it("a successful poll with no report yields no primary and no status", () => {
    const m = model();
    expect(m.primary).toBe(null);
    expect(m.secondaryLine).toBe(null);
    expect(m.statusLine).toBe(null);
    expect(m.serverPending).toBe(false);
  });

  it("keeps the incident verdict entries and adds the situation ones", () => {
    expect(kOverseerVerdictBadge.resolved).toEqual({ tone: "success", label: "Resolved" });
    expect(kOverseerVerdictBadge.monitoring).toEqual({ tone: "warning", label: "Monitoring" });
    expect(kOverseerVerdictBadge.action_needed).toEqual({ tone: "danger", label: "Action needed" });
    expect(kOverseerVerdictBadge.unparseable).toEqual({ tone: "neutral", label: "Unparseable" });
    expect(kOverseerVerdictBadge.all_clear).toEqual({ tone: "success", label: "All clear" });
    expect(kOverseerVerdictBadge.watch).toEqual({ tone: "warning", label: "Watch" });
  });
});

describe("buildWatchdogOverseerModel — situation report", () => {
  it("renders the kind label, badge and body from lastVerdict", () => {
    const m = model({ situation: payload({ lastVerdict: situationRecord() }) });
    const report = m.situationReport;
    expect(report.kind).toBe("situation");
    expect(report.kindLabel).toBe("Situation report · 5m ago");
    expect(report.badge).toEqual({ tone: "warning", label: "Watch" });
    expect(report.headline).toBe("Probes flapping");
    expect(report.summary).toBe("Two readyz failures in ten minutes.");
    expect(report.recommendation).toBe("Watch the next probe cycle.");
    expect(report.changedSince).toBe(false);
    expect(report.deltaLine).toBe(null);
    expect(m.primary).toBe(report);
  });

  it.each([
    ["all_clear", { tone: "success", label: "All clear" }],
    ["watch", { tone: "warning", label: "Watch" }],
    ["action_needed", { tone: "danger", label: "Action needed" }],
    ["unparseable", { tone: "neutral", label: "Unparseable" }],
    ["something_else", { tone: "neutral", label: "Unparseable" }],
  ])("maps verdict %s to its badge", (verdict, badge) => {
    const m = model({
      situation: payload({ lastVerdict: situationRecord({ verdict, action: "none" }) }),
    });
    expect(m.situationReport.badge).toEqual(badge);
  });

  it("evidence line: honored window", () => {
    expect(evidenceLineFor()).toBe(
      `Evidence: logs ${range(kNow - min(35), kNow - min(5))} (412 lines) · doctor: ok · status: degraded · no open incident`,
    );
  });

  it("evidence line: window cut short by the byte cap", () => {
    expect(evidenceLineFor({ logFrontTruncated: true })).toContain(
      `logs ${range(kNow - min(35), kNow - min(5))} (412 lines · window cut short)`,
    );
  });

  it("evidence line: log begins late inside the window (not capped)", () => {
    const logFrom = kNow - min(25);
    expect(evidenceLineFor({ logFrom })).toContain(
      `logs ${range(logFrom, kNow - min(5))} (412 lines · log begins ${formatLocaleTime(logFrom)})`,
    );
  });

  it("evidence line: fallback full tail when the window was not honored", () => {
    const logFrom = kNow - min(120);
    expect(
      evidenceLineFor({ logPartial: true, logLines: 2104, logFrom }),
    ).toContain(
      `logs: full tail ${range(logFrom, kNow - min(5))} (2,104 lines · 30-min window not honored)`,
    );
  });

  it("evidence line: no log lines, doctor/status/incident variants", () => {
    expect(evidenceLineFor({ logLines: 0 })).toContain("logs: none in the last 30 min");
    expect(evidenceLineFor({ logFrom: null, logThrough: null })).toContain(
      "logs: none in the last 30 min",
    );
    expect(evidenceLineFor({ doctor: "empty" })).toContain("doctor: no output");
    expect(evidenceLineFor({ doctor: "unavailable" })).toContain("doctor: unavailable");
    expect(evidenceLineFor({ status: null })).toContain("status: unavailable");
    expect(evidenceLineFor({ status: { lifecycle: "running" } })).toContain("status: unknown");
    expect(evidenceLineFor({ openIncidentId: 12 })).toContain("incident #12 ongoing");
    expect(
      model({ situation: payload({ lastVerdict: situationRecord({ evidence: null }) }) })
        .situationReport.evidenceLine,
    ).toBe(null);
  });
});

describe("buildWatchdogOverseerModel — changed since (delta line + CTA gating)", () => {
  const actionNeeded = (overrides = {}) =>
    situationRecord({ verdict: "action_needed", action: "repair", ...overrides });

  it("fresh action_needed keeps its tone and exposes the action", () => {
    const m = model({ situation: payload({ lastVerdict: actionNeeded() }) });
    expect(m.situationReport.badge.tone).toBe("danger");
    expect(m.situationReport.action).toBe("repair");
  });

  it("gateway health flip → neutral badge, delta line, action gated off", () => {
    const m = model({
      situation: payload({ lastVerdict: actionNeeded() }),
      watchdogStatus: kHealthy,
    });
    expect(m.situationReport.changedSince).toBe(true);
    expect(m.situationReport.badge).toEqual({ tone: "neutral", label: "Action needed" });
    expect(m.situationReport.deltaLine).toBe(
      `Gateway went degraded → healthy after this report. ${kOverseerCardCopy.freshRead}`,
    );
    expect(m.situationReport.action).toBe("none");
  });

  it("a lifecycle flip is named when health is unchanged; a routine phase flip is not a change", () => {
    const lifecycle = model({
      situation: payload({ lastVerdict: situationRecord() }),
      watchdogStatus: { ...kDegraded, lifecycle: "stopped" },
    });
    expect(lifecycle.situationReport.deltaLine).toContain(
      "Gateway lifecycle went running → stopped after this report.",
    );
    // Phase flips on every retry tick; treating it as "changed since" would
    // neutralize a fresh report (and hide its CTA) for nothing.
    const phase = model({
      situation: payload({ lastVerdict: situationRecord({ verdict: "action_needed", action: "repair" }) }),
      watchdogStatus: { ...kDegraded, phase: "repairing" },
    });
    expect(phase.situationReport.deltaLine).toBe(null);
    expect(phase.situationReport.action).toBe("repair");
  });

  it("hides the model-driven CTA while the deterministic ladder is mid-operation", () => {
    const m = model({
      situation: payload({ lastVerdict: situationRecord({ verdict: "action_needed", action: "repair" }) }),
      watchdogStatus: { ...kDegraded, operationInProgress: true },
    });
    expect(m.situationReport.deltaLine).toBe(null);
    expect(m.situationReport.action).toBe("none");
  });

  it("evidence line discloses the 64k evidence cap and honors the server's window size", () => {
    const capped = model({
      situation: payload({
        lastVerdict: situationRecord({ evidence: evidence({ logCapped: true, logFrontTruncated: true }) }),
      }),
    });
    expect(capped.situationReport.evidenceLine).toContain("window cut short · newest 64k chars");
    const wideWindow = model({
      situation: payload({
        lastVerdict: situationRecord({ evidence: evidence({ logLines: 0, windowMs: 60 * 60_000 }) }),
      }),
    });
    expect(wideWindow.situationReport.evidenceLine).toContain("logs: none in the last 60 min");
  });

  it("another holder of the server mutex disables the button with a reason instead of 'Reviewing…'", () => {
    const automatic = model({
      situation: payload({ inFlight: { kind: "automatic", incidentId: 7, startedAt: kNow - 5_000 } }),
    });
    expect(automatic.serverPending).toBe(false);
    expect(automatic.serverBusy).toBe(true);
    expect(automatic.statusLine).toMatchObject({ tone: "muted", source: "server" });
    expect(automatic.statusLine.text).toContain("Automatic review of incident #7 in progress");
    const incident = model({
      situation: payload({ inFlight: { kind: "incident", incidentId: 9, startedAt: kNow - 5_000 } }),
    });
    expect(incident.statusLine.text).toContain("Review of incident #9 in progress");
    // A situation report (ours or another tab's) is the normal "Reviewing…".
    const situation = model({
      situation: payload({ inFlight: { kind: "situation", incidentId: null, startedAt: kNow - 5_000 } }),
    });
    expect(situation.serverPending).toBe(true);
    expect(situation.serverBusy).toBe(false);
    // An older server's bare boolean still means a running situation report.
    expect(model({ situation: payload({ inFlight: true }) }).serverBusy).toBe(false);
    const tree = renderCard({
      situation: payload({ inFlight: { kind: "automatic", incidentId: 7, startedAt: kNow - 5_000 } }),
    });
    const button = findAllByType(tree, ActionButton).find(
      (node) => node.props.idleLabel === "Review current situation",
    );
    expect(button.props.disabled).toBe(true);
    expect(button.props.loading).toBe(false);
    expect(button.props.title).toBe("A review is already running");
  });

  it("an incident opened after collection is named", () => {
    const m = model({
      situation: payload({ lastVerdict: actionNeeded() }),
      incidents: [incidentRow(13, { status: "open", openedAt: iso(kNow - min(3)), resolvedAt: null })],
    });
    expect(m.situationReport.deltaLine).toBe(
      `Incident #13 opened after this report. ${kOverseerCardCopy.freshRead}`,
    );
    expect(m.situationReport.action).toBe("none");
  });

  it("an incident resolved after collection is named", () => {
    const m = model({
      situation: payload({
        lastVerdict: situationRecord({ evidence: evidence({ openIncidentId: 12 }) }),
      }),
      incidents: [incidentRow(12, { openedAt: iso(kNow - min(40)), resolvedAt: iso(kNow - min(2)) })],
    });
    expect(m.situationReport.deltaLine).toBe(
      `Incident #12 resolved after this report. ${kOverseerCardCopy.freshRead}`,
    );
  });

  it("open-incident identity is the backstop when timestamps are missing", () => {
    const gone = model({
      situation: payload({
        lastVerdict: situationRecord({ evidence: evidence({ openIncidentId: 12 }) }),
      }),
      incidents: [],
    });
    expect(gone.situationReport.deltaLine).toContain("Incident #12 resolved after this report.");
    const appeared = model({
      situation: payload({ lastVerdict: situationRecord() }),
      incidents: [incidentRow(14, { status: "open", openedAt: null, resolvedAt: null })],
    });
    expect(appeared.situationReport.deltaLine).toContain("Incident #14 opened after this report.");
  });

  it("no change: incidents older than collection and matching status stay fresh", () => {
    const m = model({
      situation: payload({ lastVerdict: actionNeeded() }),
      incidents: [incidentRow(11)],
    });
    expect(m.situationReport.changedSince).toBe(false);
    expect(m.situationReport.deltaLine).toBe(null);
    expect(m.situationReport.action).toBe("repair");
  });

  it("a record without evidence can't be judged stale", () => {
    const m = model({
      situation: payload({ lastVerdict: actionNeeded({ evidence: null }) }),
      watchdogStatus: kHealthy,
    });
    expect(m.situationReport.changedSince).toBe(false);
    expect(m.situationReport.action).toBe("repair");
  });

  it("only action_needed carries an action, never watch/all_clear/unparseable", () => {
    for (const verdict of ["watch", "all_clear", "unparseable"]) {
      const m = model({
        situation: payload({ lastVerdict: situationRecord({ verdict, action: "restart" }) }),
      });
      expect(m.situationReport.action).toBe("none");
    }
  });
});

describe("buildWatchdogOverseerModel — ephemeral vs polled", () => {
  it("ephemeral done beats a polled pending/older lastVerdict and hides that run's server status", () => {
    const ephemeral = situationRecord({ headline: "Fresh ephemeral", at: kNow - min(1) });
    const m = model({
      situation: payload({
        current: { state: "pending", at: kNow - min(1) },
        lastVerdict: situationRecord({ headline: "Older polled", at: kNow - min(20) }),
      }),
      ephemeral,
    });
    expect(m.situationReport.headline).toBe("Fresh ephemeral");
    expect(m.statusLine).toBe(null);
    expect(m.serverPending).toBe(false);
  });

  it("a newer polled done record beats the ephemeral", () => {
    const m = model({
      situation: payload({
        current: situationRecord({ headline: "Newer polled", at: kNow - min(1) }),
        lastVerdict: situationRecord({ headline: "Newer polled", at: kNow - min(1) }),
      }),
      ephemeral: situationRecord({ headline: "Old ephemeral", at: kNow - min(10) }),
    });
    expect(m.situationReport.headline).toBe("Newer polled");
  });

  it("a newer polled pending run still shows its status while the ephemeral report stays", () => {
    const m = model({
      situation: payload({
        current: { state: "pending", at: kNow - 45_000 },
        lastVerdict: null,
      }),
      ephemeral: situationRecord({ headline: "Mine", at: kNow - min(3) }),
    });
    expect(m.situationReport.headline).toBe("Mine");
    expect(m.statusLine.tone).toBe("muted");
    expect(m.serverPending).toBe(true);
  });
});

describe("buildWatchdogOverseerModel — status slot", () => {
  it("pending: elapsed-time line while lastVerdict keeps rendering below", () => {
    const m = model({
      situation: payload({
        current: { state: "pending", at: kNow - 45_000 },
        lastVerdict: situationRecord(),
      }),
    });
    expect(m.statusLine).toMatchObject({
      tone: "muted",
      source: "server",
      text: "Situation report running — reading status, recent logs and doctor output · started 45s ago (usually under 2 min)",
    });
    expect(m.situationReport.headline).toBe("Probes flapping");
    expect(m.serverPending).toBe(true);
  });

  it("failed → error chip with the summary; unavailable → warning line; lastVerdict survives both", () => {
    const failed = model({
      situation: payload({
        current: { state: "failed", summary: "The claude call timed out.", at: kNow - min(1) },
        lastVerdict: situationRecord(),
      }),
    });
    expect(failed.statusLine).toMatchObject({ tone: "error", text: "The claude call timed out." });
    expect(failed.situationReport.headline).toBe("Probes flapping");
    const unavailable = model({
      situation: payload({
        current: { state: "unavailable", summary: "claude CLI not found", at: kNow - min(1) },
        lastVerdict: situationRecord(),
      }),
    });
    expect(unavailable.statusLine).toMatchObject({ tone: "warning", text: "claude CLI not found" });
    expect(unavailable.situationReport.headline).toBe("Probes flapping");
    // The server's best-effort rewrite after a failed save is a durability
    // warning about a report that still exists — never a red error chip.
    const persistFailed = model({
      situation: payload({
        current: {
          state: "failed",
          reason: "persist_failed",
          summary: "The report ran but its result could not be saved.",
          at: kNow - min(1),
        },
        lastVerdict: situationRecord(),
      }),
    });
    expect(persistFailed.statusLine).toMatchObject({
      tone: "warning",
      text: "Report displayed but not saved (database write failed).",
    });
    expect(persistFailed.situationReport.headline).toBe("Probes flapping");
  });

  it("GET errors: unreadable copy, unavailable copy without data, silent with data", () => {
    expect(model({ situation: payload({ unreadable: true }) }).statusLine).toMatchObject({
      tone: "warning",
      text: kOverseerCardCopy.unreadable,
    });
    expect(
      model({ situation: null, situationError: new Error("not_wired") }).statusLine,
    ).toMatchObject({ tone: "warning", text: kOverseerCardCopy.unavailable });
    expect(
      model({ situation: payload({ lastVerdict: situationRecord() }), situationError: new Error("x") })
        .statusLine,
    ).toBe(null);
  });

  it("precedence: client-transient beats server current and GET errors until current.at advances", () => {
    const refusal = {
      tone: "error",
      text: "A review is already running",
      error: new Error("A review is already running"),
      sinceAt: kNow - min(10),
    };
    const winsOverPending = model({
      situation: payload({
        current: { state: "pending", at: kNow - min(10) },
        unreadable: true,
      }),
      reviewStatus: refusal,
    });
    expect(winsOverPending.statusLine).toMatchObject({
      tone: "error",
      text: "A review is already running",
      source: "client",
    });
    expect(winsOverPending.statusLine.error).toBe(refusal.error);
    const superseded = model({
      situation: payload({ current: { state: "pending", at: kNow - min(1) } }),
      reviewStatus: refusal,
    });
    expect(superseded.statusLine.source).toBe("server");
    expect(superseded.statusLine.tone).toBe("muted");
  });

  it("persist warning and connection-lost ride the same slot as plain lines", () => {
    const warning = model({
      reviewStatus: {
        tone: "warning",
        text: "Report displayed but not saved (database write failed).",
        sinceAt: kNow,
      },
    });
    expect(warning.statusLine).toMatchObject({ tone: "warning", source: "client" });
    const lost = model({
      reviewStatus: { tone: "muted", text: "Connection lost — …", sinceAt: kNow },
    });
    expect(lost.statusLine).toMatchObject({ tone: "muted", text: "Connection lost — …" });
  });
});

describe("buildWatchdogOverseerModel — incident report + primary selection", () => {
  it("incident report keeps today's shape plus the kind label and CTA gates", () => {
    const m = model({ incidents: [reviewed(5, incidentVerdict())] });
    const report = m.incidentReport;
    expect(report.kind).toBe("incident");
    expect(report.state).toBe("verdict");
    expect(report.kindLabel).toBe("Post-incident review · incident #5 · 20m ago");
    expect(report.badge).toEqual({ tone: "danger", label: "Action needed" });
    expect(report.action).toBe("repair");
    expect(m.primary).toBe(report);
    // Newer unreviewed incident above, or any open incident, gates the CTA.
    expect(
      model({ incidents: [incidentRow(6), reviewed(5, incidentVerdict())] }).incidentReport.action,
    ).toBe("none");
    expect(
      model({
        incidents: [reviewed(5, incidentVerdict()), incidentRow(4, { status: "open", resolvedAt: null })],
      }).incidentReport.action,
    ).toBe("none");
  });

  it("stale incident review: neutral badge + delta line, no action", () => {
    const m = model({ incidents: [reviewed(5, incidentVerdict({ state: "stale" }))] });
    expect(m.incidentReport.stale).toBe(true);
    expect(m.incidentReport.badge).toEqual({ tone: "neutral", label: "Action needed" });
    expect(m.incidentReport.deltaLine).toBe("Incident #5 changed after this review.");
    expect(m.incidentReport.action).toBe("none");
  });

  it("pending / unavailable / failed incident reviews are lines, not verdicts", () => {
    expect(
      model({ incidents: [reviewed(5, { state: "pending", at: kNow })] }).incidentReport,
    ).toMatchObject({ state: "pending", line: "Overseer review in progress…", shortLabel: "In progress" });
    expect(
      model({ incidents: [reviewed(5, { state: "unavailable", summary: "no flags" })] }).incidentReport,
    ).toMatchObject({ state: "unavailable", line: "no flags" });
    expect(
      model({ incidents: [reviewed(5, { state: "failed", summary: "timed out" })] }).incidentReport,
    ).toMatchObject({ state: "failed", line: "timed out", shortLabel: "Failed" });
  });

  it("treats corrupt overseer blobs as unreviewed", () => {
    expect(
      model({ incidents: [{ id: 5, status: "resolved", overseer: { unreadable: true } }] })
        .incidentReport,
    ).toBe(null);
    expect(model({ incidents: [incidentRow(1)] }).incidentReport).toBe(null);
  });

  it("primary = newest by `at`; the other kind rides the secondary line", () => {
    const both = {
      incidents: [reviewed(5, incidentVerdict({ at: kNow - min(20) }))],
      situation: payload({ lastVerdict: situationRecord({ at: kNow - min(5) }) }),
    };
    const m = model(both);
    expect(m.primary.kind).toBe("situation");
    expect(m.secondaryKind).toBe("incident");
    expect(m.secondaryLine).toBe(
      "Also: post-incident review for incident #5 — Action needed · 20m ago",
    );
    expect(m.newestAt).toBe(kNow - min(5));

    const olderSituation = model({
      incidents: [reviewed(5, incidentVerdict({ at: kNow - min(2) }))],
      situation: payload({ lastVerdict: situationRecord({ at: kNow - min(5) }) }),
    });
    expect(olderSituation.primary.kind).toBe("incident");
    expect(olderSituation.secondaryLine).toBe("Also: situation report — Watch · 5m ago");
  });

  it("primaryKind pins the other kind (swap) and falls back when it doesn't exist", () => {
    const both = {
      incidents: [reviewed(5, incidentVerdict({ at: kNow - min(20) }))],
      situation: payload({ lastVerdict: situationRecord({ at: kNow - min(5) }) }),
    };
    const pinned = model({ ...both, primaryKind: "incident" });
    expect(pinned.primary.kind).toBe("incident");
    expect(pinned.secondaryKind).toBe("situation");
    expect(pinned.secondaryLine).toBe("Also: situation report — Watch · 5m ago");
    const onlySituation = model({
      situation: payload({ lastVerdict: situationRecord() }),
      primaryKind: "incident",
    });
    expect(onlySituation.primary.kind).toBe("situation");
    expect(onlySituation.secondaryLine).toBe(null);
  });

  it("secondary line uses the short label for non-verdict incident reviews", () => {
    const m = model({
      incidents: [reviewed(5, { state: "pending", at: kNow - min(1) })],
      situation: payload({ lastVerdict: situationRecord() }),
      primaryKind: "situation",
    });
    expect(m.secondaryLine).toBe(
      "Also: post-incident review for incident #5 — In progress · 1m ago",
    );
  });
});

describe("buildWatchdogOverseerModel — scope line + rate limit", () => {
  it("scope line vocabulary", () => {
    expect(buildWatchdogScopeLine({ watchdogStatus: kHealthy, incidents: [] })).toBe(
      "Scope: gateway healthy · no open incident",
    );
    expect(
      buildWatchdogScopeLine({
        watchdogStatus: kDegraded,
        incidents: [incidentRow(12, { status: "open", resolvedAt: null })],
      }),
    ).toBe("Scope: gateway degraded · incident #12 ongoing");
    expect(
      buildWatchdogScopeLine({ watchdogStatus: { health: "unhealthy" }, incidents: [] }),
    ).toBe("Scope: gateway unhealthy · no open incident");
    expect(buildWatchdogScopeLine({ watchdogStatus: {}, incidents: [] })).toBe(
      "Scope: gateway status unknown · no open incident",
    );
    expect(model().scopeLine).toBe("Scope: gateway degraded · no open incident");
  });

  it("rate-limit countdown from nextManualAt", () => {
    const limited = model({ situation: payload({ nextManualAt: kNow + 72_000 }) });
    expect(limited.rateLimitRemainingMs).toBe(72_000);
    expect(limited.availableInLine).toBe("Available in 1m 12s");
    const open = model({ situation: payload({ nextManualAt: kNow - 1000 }) });
    expect(open.rateLimitRemainingMs).toBe(0);
    expect(open.availableInLine).toBe(null);
    expect(model({ situation: payload({ nextManualAt: null }) }).availableInLine).toBe(null);
  });

  it("serverPending follows the server's inFlight flag", () => {
    expect(model({ situation: payload({ inFlight: true }) }).serverPending).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Card rendering (vnode walk, function children expanded).

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch {
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) {
    out.props = { ...out.props, children: expandTree(out.props.children) };
  }
  return out;
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  if (node.rendered) collectNodes(node.rendered, out);
  return out;
};

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
    if (node.props) collectText(node.props.children, out);
    if (node.rendered) collectText(node.rendered, out);
  }
  return out;
};

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const renderCard = (props = {}) => {
  harness.beginRender();
  return expandTree(
    WatchdogOverseerCard({
      incidents: [],
      watchdogStatus: kDegraded,
      enabled: true,
      availability: { available: true, reason: null, message: "ok" },
      settingsLoaded: true,
      situation: payload(),
      ...props,
    }),
  );
};

const textOf = (tree) => collectText(tree).join(" ").replace(/\s+/g, " ");

describe("WatchdogOverseerCard rendering", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("keeps the loading shell until settings AND the first poll land", () => {
    expect(textOf(renderCard({ settingsLoaded: false }))).toContain("Loading overseer status...");
    expect(textOf(renderCard({ situation: null, situationError: null }))).toContain(
      "Loading overseer status...",
    );
    expect(textOf(renderCard())).not.toContain("Loading overseer status...");
  });

  it("enabled + available: button, scope line, copy, empty state; availability line hidden", () => {
    const tree = renderCard();
    const buttons = findAllByType(tree, ActionButton);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props).toMatchObject({
      idleLabel: "Review current situation",
      loadingLabel: "Reviewing...",
      tone: "secondary",
      size: "sm",
      loading: false,
      disabled: false,
    });
    const text = textOf(tree);
    expect(text).toContain("Scope: gateway degraded · no open incident");
    expect(text).toContain(kOverseerCardCopy.description);
    expect(text).toContain(kOverseerCardCopy.disclosure);
    expect(text).toContain(kOverseerCardCopy.emptyTitle);
    expect(text).toContain(kOverseerCardCopy.emptyBody);
    expect(text).not.toContain("Availability:");
    expect(findAllByType(tree, ToggleSwitch)[0].props.checked).toBe(true);
  });

  it("disabled toggle: no button, no scope, no empty state; existing reports stay visible", () => {
    const tree = renderCard({
      enabled: false,
      situation: payload({ lastVerdict: situationRecord() }),
    });
    expect(findAllByType(tree, ActionButton)).toHaveLength(0);
    const text = textOf(tree);
    expect(text).not.toContain("Scope:");
    expect(text).not.toContain(kOverseerCardCopy.emptyTitle);
    expect(text).toContain("Probes flapping");
  });

  it("claude unavailable: button disabled with a title, availability line shown, scope hidden", () => {
    const tree = renderCard({
      availability: { available: false, reason: "no_cli", message: "claude CLI not found" },
    });
    const button = findAllByType(tree, ActionButton)[0];
    expect(button.props.disabled).toBe(true);
    expect(button.props.title).toBe("Waiting for claude availability");
    const text = textOf(tree);
    expect(text).toContain("Availability: claude CLI not found");
    expect(text).not.toContain("Scope:");
    expect(textOf(renderCard({ availability: { available: null } }))).toContain(
      "Checking claude availability",
    );
    expect(textOf(renderCard({ availability: null }))).toContain("Availability: unknown");
  });

  it("rate limited: countdown replaces the scope line and disables the button", () => {
    const realNow = Date.now;
    Date.now = () => kNow;
    try {
      const tree = renderCard({ situation: payload({ nextManualAt: kNow + 72_000 }) });
      const button = findAllByType(tree, ActionButton)[0];
      expect(button.props.disabled).toBe(true);
      expect(button.props.title).toBe("Available in 1m 12s");
      const text = textOf(tree);
      expect(text).toContain("Available in 1m 12s");
      expect(text).not.toContain("Scope:");
    } finally {
      Date.now = realNow;
    }
  });

  it("reviewInFlight === 'situation' or a server pending record puts the button in loading and hides scope", () => {
    const inFlight = renderCard({ reviewInFlight: "situation" });
    expect(findAllByType(inFlight, ActionButton)[0].props.loading).toBe(true);
    expect(textOf(inFlight)).not.toContain("Scope:");
    const realNow = Date.now;
    Date.now = () => kNow;
    // Fresh slots: useNowMs seeds its state from Date.now() on first render.
    harness.reset();
    try {
      const pending = renderCard({
        situation: payload({ current: { state: "pending", at: kNow - 45_000 } }),
      });
      expect(findAllByType(pending, ActionButton)[0].props.loading).toBe(true);
      expect(textOf(pending)).toContain("Situation report running");
      expect(textOf(pending)).toContain("started 45s ago");
    } finally {
      Date.now = realNow;
    }
    // An incident review in flight does NOT put the situation button in loading.
    expect(findAllByType(renderCard({ reviewInFlight: 7 }), ActionButton)[0].props.loading).toBe(
      false,
    );
  });

  it("status slot: error → InlineErrorChip; warning/muted → plain role=status lines", () => {
    const refusal = new Error("Manual reviews are limited to one every 2 minutes");
    const chipTree = renderCard({
      reviewStatus: { tone: "error", text: refusal.message, error: refusal, sinceAt: 0 },
    });
    const chips = findAllByType(chipTree, InlineErrorChip);
    expect(chips).toHaveLength(1);
    expect(chips[0].props.headline).toBe(refusal.message);
    expect(chips[0].props.error).toBe(refusal);

    const warningTree = renderCard({
      reviewStatus: {
        tone: "warning",
        text: "Report displayed but not saved (database write failed).",
        sinceAt: 0,
      },
    });
    const statusP = collectNodes(warningTree).find(
      (node) => node.type === "p" && node.props.role === "status",
    );
    expect(statusP.props.class).toContain("text-status-warning-muted");
    expect(statusP.props["aria-live"]).toBe("polite");
    expect(findAllByType(warningTree, InlineErrorChip)).toHaveLength(0);

    const failedTree = renderCard({
      situation: payload({ current: { state: "failed", summary: "spawn failed", at: kNow } }),
    });
    expect(findAllByType(failedTree, InlineErrorChip)[0].props.headline).toBe("spawn failed");
  });

  it("ReportAction renders every action variant (restart needs a handler; rollback links; fix_config hints)", () => {
    const withAction = (action, extra = {}) =>
      renderCard({
        situation: payload({
          lastVerdict: situationRecord({ verdict: "action_needed", action, at: kNow - min(5) }),
        }),
        ...extra,
      });
    const onRestartGateway = vi.fn();
    const restart = findAllByType(withAction("restart", { onRestartGateway }), ActionButton).find(
      (node) => node.props.idleLabel === "Restart gateway",
    );
    expect(restart.props.onClick).toBe(onRestartGateway);
    expect(
      findAllByType(withAction("restart"), ActionButton).some(
        (node) => node.props.idleLabel === "Restart gateway",
      ),
    ).toBe(false);
    const onResumeChannels = vi.fn();
    const resume = findAllByType(withAction("resume_channels", { onResumeChannels }), ActionButton).find(
      (node) => node.props.idleLabel === "Resume channels",
    );
    expect(resume.props.onClick).toBe(onResumeChannels);
    expect(textOf(withAction("rollback"))).toContain("Review rollback on the Upgrade page");
    expect(textOf(withAction("fix_config"))).toContain("Fix openclaw.json");
  });

  it("a running report never ticks inside the live region; the elapsed counter is aria-hidden and the kind label can wrap", () => {
    const tree = renderCard({
      situation: payload({
        current: { state: "pending", at: kNow - 45_000 },
        lastVerdict: situationRecord(),
      }),
    });
    const live = collectNodes(tree).find((node) => node.type === "p" && node.props.role === "status");
    expect(live.props["aria-live"]).toBe("polite");
    expect(textOf(live)).not.toContain("started");
    expect(textOf(live)).toContain("Situation report running");
    const hidden = collectNodes(tree).find(
      (node) => node.type === "span" && node.props["aria-hidden"] === "true" && textOf(node).includes("started"),
    );
    expect(hidden).toBeTruthy();
    const label = collectNodes(tree).find(
      (node) =>
        node.type === "span" &&
        typeof node.props.class === "string" &&
        node.props.class.includes("break-words") &&
        textOf(node).includes("Situation report"),
    );
    expect(label).toBeTruthy();
    expect(label.props.class).not.toContain("whitespace-nowrap");
  });

  it("report block: badge, kind label, delta line, → recommendation, evidence, CTA, secondary swap", () => {
    const onSelectPrimaryKind = vi.fn();
    const onRepair = vi.fn();
    const tree = renderCard({
      incidents: [reviewed(5, incidentVerdict({ at: kNow - min(20) }))],
      situation: payload({
        lastVerdict: situationRecord({ verdict: "action_needed", action: "repair", at: kNow - min(5) }),
      }),
      onSelectPrimaryKind,
      onRepair,
    });
    const badges = findAllByType(tree, Badge);
    expect(badges).toHaveLength(1);
    expect(badges[0].props.tone).toBe("danger");
    const text = textOf(tree);
    expect(text).toContain("Action needed");
    expect(text).toContain("Situation report ·");
    expect(text).toContain("→ Watch the next probe cycle.");
    expect(text).toContain("Evidence: logs");
    expect(text).toContain("Also: post-incident review for incident #5");
    // CTA is the existing repair handler.
    const repair = findAllByType(tree, ActionButton).find(
      (node) => node.props.idleLabel === "Run repair",
    );
    expect(repair.props.onClick).toBe(onRepair);
    // Secondary line swaps the primary kind.
    const swap = collectNodes(tree).find(
      (node) => node.type === "button" && node.props.class?.includes("ac-tip-link"),
    );
    swap.props.onclick();
    expect(onSelectPrimaryKind).toHaveBeenCalledWith("incident");
  });

  it("changed-since: neutral badge + delta line and NO CTA", () => {
    const tree = renderCard({
      watchdogStatus: kHealthy,
      situation: payload({
        lastVerdict: situationRecord({ verdict: "action_needed", action: "repair" }),
      }),
    });
    expect(findAllByType(tree, Badge)[0].props.tone).toBe("neutral");
    expect(textOf(tree)).toContain("Gateway went degraded → healthy after this report.");
    expect(
      findAllByType(tree, ActionButton).some((node) => node.props.idleLabel === "Run repair"),
    ).toBe(false);
  });
});
