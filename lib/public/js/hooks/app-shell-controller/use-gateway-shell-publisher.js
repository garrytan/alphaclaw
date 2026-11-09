import { useEffect, useRef } from "preact/hooks";
import { gatewayShellStore } from "../../components/restart-progress-card.js";

const kShellActionKeys = [
  "restart",
  "refresh",
  "resumeChannels",
  "dismissOutcome",
  "dismissRestartBanner",
  "scheduleRestart",
  "cancelScheduledRestart",
  "loadEvidence",
  "retryConnect",
  "openSetup",
  "retryUpgrade",
  "confirmWorkspaceMove",
  "refreshUpgradeStatus",
];

// Publishes the gateway-facing slice for the Gateway card and global banner
// (they render in trees the controller's props don't reach). `read` returns
// this render's `{ actions, state }` and runs after the render commits.
export const useGatewayShellPublisher = (read) => {
  // Latest-ref delegation for shell actions (stable identities across
  // renders so store subscribers only re-render on real state changes).
  const shellActionsRef = useRef({});
  const stableShellActionsRef = useRef(null);
  if (!stableShellActionsRef.current) {
    const stable = {};
    for (const key of kShellActionKeys) {
      stable[key] = (...args) => shellActionsRef.current[key]?.(...args);
    }
    stableShellActionsRef.current = stable;
  }

  useEffect(() => {
    // Stable action identities: the handlers close over per-render state, so
    // publish latest-ref delegates instead — the store's shallow compare can
    // then skip no-change publishes (each 2s frame re-renders this hook).
    const { actions, state } = read();
    shellActionsRef.current = actions;
    gatewayShellStore.publish({ ...state, actions: stableShellActionsRef.current });
  });
};
