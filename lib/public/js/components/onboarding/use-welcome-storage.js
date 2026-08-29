import { useEffect, useState } from "preact/hooks";

import { kOnboardingStorageKey } from "../../lib/storage-keys.js";
export { kOnboardingStorageKey };
export const kOnboardingStepKey = "_step";
export const kPairingChannelKey = "_pairingChannel";
export const kOnboardingSetupErrorKey = "_lastSetupError";

// Credential-shaped onboarding fields (provider keys, bot/gateway tokens) must
// never be persisted to localStorage in plaintext (MW1) — they'd survive an
// abandoned onboarding indefinitely. Only UI/progress state is persisted.
// Matches *_API_KEY / *_PRIVATE_KEY but NOT a bare *_KEY like MODEL_KEY (the
// user's model selection, which is a non-secret UI value worth restoring).
const kSecretValKeyPattern =
  /(_TOKEN|_API_KEY|_PRIVATE_KEY|_SECRET|_PASSWORD)$/i;
export const stripSecretVals = (vals = {}) =>
  Object.fromEntries(
    Object.entries(vals).filter(([key]) => !kSecretValKeyPattern.test(key)),
  );

const loadInitialSetupState = () => {
  try {
    return JSON.parse(localStorage.getItem(kOnboardingStorageKey) || "{}");
  } catch {
    return {};
  }
};

export const useWelcomeStorage = ({
  kSetupStepIndex,
  kPairingStepIndex,
} = {}) => {
  const [initialSetupState] = useState(loadInitialSetupState);
  const [vals, setVals] = useState(() => ({ ...initialSetupState }));
  const [setupError, setSetupError] = useState(null);
  const initialSetupError = String(
    initialSetupState?.[kOnboardingSetupErrorKey] || "",
  ).trim();
  const shouldRecoverFromSetupState = !!initialSetupError;
  const [step, setStep] = useState(() => {
    const parsedStep = Number.parseInt(
      String(initialSetupState?.[kOnboardingStepKey] || ""),
      10,
    );
    if (!Number.isFinite(parsedStep)) return -1;
    const clampedStep = Math.max(-1, Math.min(kPairingStepIndex, parsedStep));
    if (clampedStep === kSetupStepIndex && shouldRecoverFromSetupState) return 0;
    return clampedStep;
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        kOnboardingStorageKey,
        JSON.stringify({
          ...stripSecretVals(vals),
          [kOnboardingStepKey]: step,
          ...(setupError ? { [kOnboardingSetupErrorKey]: setupError } : {}),
        }),
      );
    } catch {
      // Quota/private-mode failures must not break onboarding (matches every
      // other localStorage call site's try/catch).
    }
  }, [vals, step, setupError]);

  const setValue = (key, value) => setVals((prev) => ({ ...prev, [key]: value }));

  return {
    vals,
    setVals,
    setValue,
    step,
    setStep,
    setupError,
    setSetupError,
  };
};
