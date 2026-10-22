const {
  kAskExitClasses,
  kAskGatewayStates,
  kAskDecisions,
  classifyAskExit,
  classifyAskProbe,
  decideAfterAskExit,
} = require("../../lib/server/gateway-ask-outcome");

// Verbatim from the pinned CLI (dist/transport-error-*.mjs), as the incident
// and the stall reproduction printed it.
const kUnknownTail = [
  "Gateway restart failed: GatewayTransportError: gateway timeout after 10000ms",
  "Gateway target: ws://127.0.0.1:19585",
  "The request was already sent to the gateway, so the operation may have been applied even though no response arrived; its outcome is unknown. Verify the current state (for example, re-run the equivalent read-only command) before retrying, especially for write actions.",
];

describe("gateway-ask-outcome: what a non-zero 'gateway restart --wait' exit means", () => {
  it("classifies the CLI's exit: explicit OpenClaw refusals, post-dispatch uncertainty, signal deaths and everything else", () => {
    expect(classifyAskExit({ code: 1, lines: kUnknownTail })).toBe(kAskExitClasses.UNKNOWN);
    expect(classifyAskExit({ code: 1, lines: ["gateway closed (1012): service restart"] })).toBe(kAskExitClasses.UNKNOWN);
    expect(classifyAskExit({ code: null, signal: "SIGKILL", lines: [] })).toBe(kAskExitClasses.UNKNOWN);
    for (const line of [
      "Gateway restart failed: Error: target gateway no longer owns the active lock",
      "Gateway restart failed: Error: multiple gateway processes are listening on port 18789: 1, 2",
      "Gateway restart failed: the active Gateway lock predates targeted restart ownership; update the running Gateway before retrying",
      "No verified gateway process is listening on port 18789.",
      "Gateway restart is disabled in the running gateway config (commands.restart=false)",
    ]) {
      expect(classifyAskExit({ code: 1, lines: [line] })).toBe(kAskExitClasses.REJECTED);
    }
    // An explicit refusal wins even when the CLI then died by signal.
    expect(classifyAskExit({ code: null, signal: "SIGTERM", lines: ["target gateway no longer owns the active lock"] })).toBe(kAskExitClasses.REJECTED);
    expect(classifyAskExit({ code: 1, lines: ["something else entirely"] })).toBe(kAskExitClasses.FAILED);
    expect(classifyAskExit({ code: null, error: new Error("spawn openclaw ENOENT") })).toBe(kAskExitClasses.FAILED);
  });

  it("maps /readyz observations to the gateway's admission state", () => {
    expect(classifyAskProbe({ ok: true, kind: "ready", ready: true })).toBe(kAskGatewayStates.ADMITTING);
    expect(classifyAskProbe({ ok: true, kind: "not_ready", unreadyReason: "draining" })).toBe(kAskGatewayStates.DRAINING);
    expect(classifyAskProbe({ ok: false, kind: "unavailable", httpStatus: null, reason: "fetch failed" })).toBe(kAskGatewayStates.CLOSED);
    expect(classifyAskProbe({ ok: false, kind: "timeout", httpStatus: null })).toBe(kAskGatewayStates.INCONCLUSIVE);
    expect(classifyAskProbe({ ok: false, kind: "unavailable", httpStatus: 502 })).toBe(kAskGatewayStates.INCONCLUSIVE);
    expect(classifyAskProbe({ ok: true, kind: "not_ready", unreadyReason: "components" })).toBe(kAskGatewayStates.INCONCLUSIVE);
    expect(classifyAskProbe(null)).toBe(kAskGatewayStates.INCONCLUSIVE);
  });

  it("decides: draining or closed waits whatever the CLI said; admitting must be confirmed twice; a confirmed admitting gateway is re-asked once after an unknown outcome, else escalated", () => {
    const { ADMITTING, DRAINING, CLOSED, INCONCLUSIVE } = kAskGatewayStates;
    for (const exitClass of Object.values(kAskExitClasses)) {
      expect(decideAfterAskExit({ exitClass, states: [DRAINING] })).toBe(kAskDecisions.WAIT);
      expect(decideAfterAskExit({ exitClass, states: [ADMITTING, CLOSED] })).toBe(kAskDecisions.WAIT);
      expect(decideAfterAskExit({ exitClass, states: [ADMITTING] })).toBe(kAskDecisions.WAIT);
    }
    // 2026.10.6 reopens and re-closes the fence within milliseconds.
    expect(decideAfterAskExit({ exitClass: "unknown", states: [ADMITTING, DRAINING], graceLeftFraction: 1 })).toBe(kAskDecisions.WAIT);
    expect(decideAfterAskExit({ exitClass: "unknown", states: [ADMITTING, ADMITTING], attempt: 1, graceLeftFraction: 0.8 })).toBe(kAskDecisions.REASK);
    expect(decideAfterAskExit({ exitClass: "unknown", states: [ADMITTING, ADMITTING], attempt: 1, graceLeftFraction: 0.3 })).toBe(kAskDecisions.ESCALATE);
    expect(decideAfterAskExit({ exitClass: "unknown", states: [ADMITTING, ADMITTING], attempt: 2, graceLeftFraction: 0.9 })).toBe(kAskDecisions.ESCALATE);
    expect(decideAfterAskExit({ exitClass: "rejected", states: [ADMITTING, ADMITTING], graceLeftFraction: 1 })).toBe(kAskDecisions.ESCALATE);
    expect(decideAfterAskExit({ exitClass: "failed", states: [ADMITTING, ADMITTING], graceLeftFraction: 1 })).toBe(kAskDecisions.ESCALATE);
    // Inconclusive: an explicit rejection is believed, anything else waits.
    expect(decideAfterAskExit({ exitClass: "rejected", states: [INCONCLUSIVE] })).toBe(kAskDecisions.ESCALATE);
    expect(decideAfterAskExit({ exitClass: "unknown", states: [INCONCLUSIVE, INCONCLUSIVE] })).toBe(kAskDecisions.WAIT);
    expect(decideAfterAskExit({ exitClass: "failed", states: [] })).toBe(kAskDecisions.WAIT);
  });
});
