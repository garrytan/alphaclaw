const { actionsForState, getGatewayRecoveryAction, kGatewayStateCatalog, reduceGatewayState } = require("../../lib/server/gateway-state");
const fs = require("node:fs");
const path = require("node:path");
const helpAnchors = new Set(fs.readFileSync(path.join(__dirname, "../../docs/upgrade-troubleshooting.md"), "utf8")
  .split("\n").filter((line) => /^#{1,6} /.test(line))
  .map((line) => line.replace(/^#+ /, "").toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")));

describe("gateway recovery inspection contract", () => {
  it.each(Object.keys(kGatewayStateCatalog))("keeps both controls usable across modifiers in %s", (state) => {
    for (const modifiers of [
      {}, { operationActive: true }, { relaunchActive: true },
      { gatewayHeld: { reason: "state_db_unverified" } },
      { gatewayHeld: { reason: "state_db_unreadable" }, gatewayHoldUnreadable: true },
      { databaseRecoveryPending: { recoveryId: "prior-recovery", baseline: { identity: "original-databases" } } },
      { stopped: true }, { paused: true },
    ]) {
      for (const id of ["repair", "restart"]) {
        const action = actionsForState(state, modifiers).find((action) => action.id === id);
        expect(action).toBeTruthy();
        expect(action.disabledReason).toBeUndefined();
        expect(["execute", "inspect", "attach", "blocked"]).toContain(action.disposition);
      }
    }
  });

  it("keeps historical holds below operation observation and freshness above both", () => {
    const modifiers = { operationActive: true, gatewayHeld: { reason: "state_db_unverified", at: "2026-09-26T00:00:00Z" }, stopped: true };
    const busy = actionsForState("down", modifiers)[0];
    expect(busy).toMatchObject({ disposition: "attach", resolution: "operation", stopped: true, originalHold: { reason: "state_db_unverified" } });
    const stale = actionsForState("unknown", modifiers)[0];
    expect(stale).toMatchObject({ disposition: "inspect", reasonCode: "status_unavailable" });
    const held = actionsForState("down", { ...modifiers, operationActive: false })[0];
    expect(held).toMatchObject({ disposition: "inspect", resolution: "verify_start", stopped: true });
  });

  it("does not describe a database hold as a rejected configuration", () => {
    const state = reduceGatewayState({ configExists: true, tcp: { running: false, observedAt: Date.now() }, watchdog: { lifecycle: "configuration_error" }, gatewayHeld: { reason: "state_db_unverified" } });
    expect(state.reason).toContain("database verification");
    expect(state.reason).not.toContain("rejected its configuration");
  });

  it("normalizes historical hold time without exposing its stored root metadata", () => {
    const action = actionsForState("down", { gatewayHeld: { reason: "state_db_unverified", at: 0, databaseVerification: { identity: "observed-build-identity", stateDir: "/private/state" } } })[0];
    expect(action.originalHold).toEqual({ reason: "state_db_unverified", observedAt: "1970-01-01T00:00:00.000Z", identity: "observed-build-identity" });
    expect(actionsForState("running", { gatewayHeld: null })[0].originalHold).toBeNull();
    expect(actionsForState("down", { gatewayHeld: { reason: "state_db_unverified", at: 1e100 } })[0].originalHold.observedAt).toBeNull();
  });

  it("keeps a persisted pending-database baseline inspect-only after the hold has cleared", () => {
    const databaseRecoveryPending = { recoveryId: "prior-recovery", baseline: { identity: "original-databases", stateDir: "/private/root" } };
    const state = reduceGatewayState({ configExists: true, tcp: { running: false, observedAt: Date.now() }, watchdog: { lifecycle: "stopped" }, gatewayHeld: null, databaseRecoveryPending });
    for (const id of ["repair", "restart"]) {
      expect(state.actions.find((action) => action.id === id)).toMatchObject({
        disposition: "inspect", resolution: "verify_start", reasonCode: "database_recovery_pending", originalHold: null,
        pendingRecovery: { recoveryId: "prior-recovery", identity: "original-databases" },
      });
    }
    expect(state.reason).toContain("original databases");
    expect(JSON.stringify(state.actions)).not.toContain("/private/root");
    expect(actionsForState("down", { databaseRecoveryPending, operationActive: true })[0].resolution).toBe("operation");
  });

  it.each([
    ["EACCES", "inspect_access", "database-access-unreadable"],
    ["EPERM", "inspect_access", "database-access-unreadable"],
    ["gateway_hold_unreadable", "inspect_recovery_state", "recovery-state-unreadable"],
    ["SQLITE_CORRUPT", "inspect_database", "restoring-a-config-checkpoint-or-database-set"],
    ["SQLITE_NOTADB", "inspect_database", "restoring-a-config-checkpoint-or-database-set"],
    ["state_db_unreadable", "inspect_database", "restoring-a-config-checkpoint-or-database-set"],
    ["SQLITE_BUSY", "inspect_database", "database-verification-held"],
    ["unsupported_transient_artifact_contract", "inspect_build_contract", "unsupported-transient-artifact-contract"],
    ["unsupported_source_schema_contract", "inspect_database", "database-schema-or-owner-unknown"],
    ["unsupported_target_schema_contract", "inspect_database", "database-schema-or-owner-unknown"],
    ["database_schema_newer_than_target", "open_compatible_builds", "version-mismatch--running--expected"],
    ["recovery_choice_required", "open_protection_choice", "config-first-upgrade-recovery"],
    ["no_installation_evidence", "choose_explicit_root", "database-verification-held"],
    ["recovery_inventory_unavailable", "inspect_database", "database-verification-held"],
    ["database_recovery_pending", "inspect_database", "database-verification-held"],
    ["configuration_error", "open_config_repair", "configuration-rejected"],
  ])("maps %s to safe, reachable instructions", (reason, id, anchor) => {
    const action = getGatewayRecoveryAction(reason);
    expect(action.id).toBe(id);
    expect(action.helpRef).toBe(`docs/upgrade-troubleshooting.md#${anchor}`);
    expect(helpAnchors.has(anchor)).toBe(true);
    expect(action.description.length).toBeGreaterThan(40);
  });
});
