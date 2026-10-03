const { actionsForState, getGatewayRecoveryAction, kGatewayStateCatalog, reduceGatewayState } = require("../../lib/server/gateway-state");

describe("gateway recovery inspection contract", () => {
  it.each(Object.keys(kGatewayStateCatalog))("keeps both controls usable across modifiers in %s", (state) => {
    for (const modifiers of [
      {}, { operationActive: true }, { relaunchActive: true },
      { stopped: true }, { paused: true }, { stopped: true, paused: true },
    ]) {
      for (const id of ["repair", "restart"]) {
        const action = actionsForState(state, modifiers).find((action) => action.id === id);
        expect(action).toBeTruthy();
        expect(action.disabledReason).toBeUndefined();
        expect(["execute", "inspect", "attach"]).toContain(action.disposition);
        expect(["diagnose", "operation", "setup", null]).toContain(action.resolution);
        expect(action).not.toHaveProperty("pendingRecovery");
        expect(action).not.toHaveProperty("originalHold");
        expect(action).not.toHaveProperty("recoveryConfirmation");
      }
    }
  });

  it("puts freshness above operation observation and operation above stop/pause", () => {
    const modifiers = { operationActive: true, stopped: true, paused: true, operation: { operationId: "op-1" } };
    const busy = actionsForState("down", modifiers)[0];
    expect(busy).toMatchObject({ disposition: "attach", resolution: "operation", reasonCode: "operation_in_progress", operationId: "op-1", stopped: true, paused: true });
    expect(busy.additionalReasons.map((reason) => reason.code)).toEqual(["stopped", "auto_repair_paused"]);
    const stale = actionsForState("unknown", modifiers)[0];
    expect(stale).toMatchObject({ disposition: "inspect", resolution: "diagnose", reasonCode: "status_unavailable" });
    const stopped = actionsForState("down", { ...modifiers, operationActive: false })[0];
    expect(stopped).toMatchObject({ disposition: "execute", resolution: null, reasonCode: "stopped", stopped: true });
    expect(actionsForState("not_onboarded", {})[0]).toMatchObject({ disposition: "inspect", resolution: "setup", reasonCode: "not_onboarded" });
    expect(actionsForState("running", { relaunchActive: true })[0]).toMatchObject({ disposition: "attach", resolution: "operation" });
    expect(actionsForState("running", {})[0]).toMatchObject({ disposition: "execute", resolution: null, reasonCode: null, reason: null, nextAction: null });
  });

  it("never projects the retired hold or database-recovery inputs", () => {
    const state = reduceGatewayState({
      configExists: true, tcp: { running: false, observedAt: Date.now() }, watchdog: { lifecycle: "stopped" },
      gatewayHeld: { reason: "state_db_unverified" }, databaseRecoveryPending: { recoveryId: "prior", baseline: { stateDir: "/private/root" } },
    });
    expect(state.reason).not.toContain("database verification");
    expect(JSON.stringify(state)).not.toMatch(/state_db_unverified|database_recovery_pending|\/private\/root|roll_back/);
    expect(state.actions.map((action) => action.id)).not.toContain("roll_back");
  });

  it.each([
    ["operation_in_progress", "observe_operation"],
    ["relaunch", "observe_operation"],
    ["booting", "observe_operation"],
    ["auto_repair_paused", "review_pause"],
    ["stopped", "review_pause"],
    ["not_onboarded", "complete_setup"],
    ["status_unavailable", "refresh_status"],
    ["state_db_unverified", "refresh_status"],
  ])("maps %s to safe, reachable instructions", (reason, id) => {
    const action = getGatewayRecoveryAction(reason);
    expect(action.id).toBe(id);
    expect(action.label.length).toBeGreaterThan(0);
    expect(action.description.length).toBeGreaterThan(40);
    expect(action).not.toHaveProperty("helpRef");
  });
});
