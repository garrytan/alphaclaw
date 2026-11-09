import { useState, useEffect, useCallback } from "preact/hooks";
import { fetchAuthStatus, fetchAuthIdentity } from "../../lib/api.js";
import { startOnboardStatusLoad } from "../../lib/shell-connectivity.js";

// Read once on mount: whether the box is onboarded, whether login is on and
// the signed-in caller's role.
export const useAuthBootstrap = () => {
  const [onboarded, setOnboarded] = useState(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  // "admin" (legacy or member-admin) | "member" | null while unknown.
  const [identityRole, setIdentityRole] = useState(null);

  useEffect(() => {
    const stopOnboardLoad = startOnboardStatusLoad({
      onResolved: setOnboarded,
    });
    fetchAuthStatus()
      .then((data) => setAuthEnabled(!!data.authEnabled))
      .catch(() => {});
    fetchAuthIdentity()
      .then((data) => setIdentityRole(data?.identity?.role || null))
      .catch(() => {});
    return stopOnboardLoad;
  }, []);

  // Server action id "setup" (the not_onboarded state's only action): the
  // setup surface the app already owns is the Welcome wizard, gated on
  // `onboarded` — the state is reachable while the client-side flag is true
  // (onboarding marker present but openclaw.json missing), so flip the gate.
  const handleOpenSetup = useCallback(() => {
    setOnboarded(false);
    window.requestAnimationFrame?.(() => document.getElementById("gateway-setup")?.focus());
  }, []);

  return {
    onboarded,
    authEnabled,
    identityRole,
    handleOpenSetup,
    handleOnboardingComplete: () => setOnboarded(true),
  };
};
