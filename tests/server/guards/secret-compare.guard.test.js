// Guard (e): secrets are compared in constant time. A raw ===/!== on a
// token, password, session signature, cookie value or capability ends early
// at the first differing byte, and a length short-circuit before
// crypto.timingSafeEqual tells a prober the secret's length. Gmail push
// compared its token with !== and auth/proxy/members/control-ui-attach each
// carried their own variant; all of them now call timingSafeStringEqual in
// lib/server/utils/timing-safe.js (sha256 both sides, then timingSafeEqual).
// The scanner flags a raw comparison whose operand is secret-named and any
// direct crypto.timingSafeEqual call outside the helper.
const { auditTree, formatHits } = require("./guard-utils");
const { scanSecretCompares } = require("./scanners");

// Content-keyed (`<left> <op> <right>`, #n for repeats). Every entry is a
// comparison where no request-supplied value meets a secret, so timing
// reveals nothing an attacker does not already hold. Add one only with a
// why-comment; route anything that authenticates a caller through the helper.
const kKnownOffenders = {
  // Channel env bookkeeping: matches a newly saved bot token against tokens
  // already in .env to find the duplicate/orphaned key. Both sides are the
  // operator's own stored values, on an admin-only write path.
  "lib/server/agents/channels.js::existingValue === token": "server-side dedupe of stored channel tokens",
  "lib/server/agents/channels.js::existingValue === appToken": "server-side dedupe of stored channel tokens",
  "lib/server/agents/channels.js::existingValue === nextAppToken": "server-side dedupe of stored channel tokens",
  "lib/server/agents/channels.js::existingAppToken !== nextAppToken": "server-side change detection of stored channel tokens",
  "lib/server/agents/channels.js::existingValue === nextToken": "server-side dedupe of stored channel tokens",
  "lib/server/agents/channels.js::existingToken !== nextToken": "server-side change detection of stored channel tokens",
  // Content fingerprints named "signature", not credentials: .env file
  // stat/content signatures, the doctor's env-change signature and the
  // gateway's stripped-flags / dropped-env log de-duplication.
  "lib/server/doctor/service.js::lastAutoRun?.envSignature === envSignature": "content fingerprint, not a credential",
  "lib/server/doctor/service.js::lastEnvSignature !== envSignature": "content fingerprint, not a credential",
  "lib/server/env.js::signature === pendingSelfWriteSignature": "content fingerprint, not a credential",
  "lib/server/env.js::signature === lastLoadedEnvSignature": "content fingerprint, not a credential",
  "lib/server/gateway-env-policy.js::signature !== lastDroppedSignature": "content fingerprint, not a credential",
  "lib/server/gateway.js::signature === lastStrippedFlagsSignature": "content fingerprint, not a credential",
  // Process identity (pid + start time) for the memory monitor, not a secret.
  "lib/server/gateway-memory-monitor.js::identityToken !== currentIdentityToken": "process identity, not a credential",
  // Config migration: is the stored value already the ${ENV} reference
  // literal? Compares the operator's own config with a public constant.
  "lib/server/onboarding/index.js::currentToken !== expectedTokenRef": "config ref migration, public constant",
  "lib/server/onboarding/index.js::currentWebhookToken !== expectedWebhookTokenRef": "config ref migration, public constant",
  // Team-auth transition decides whether the chosen gateway secret came from
  // env (write an env reference) or must be written literally. Server-held
  // values only.
  "lib/server/team-auth-transition.js::value === envPassword": "picks env ref vs literal, server-held values",
  "lib/server/team-auth-transition.js::value === envToken": "picks env ref vs literal, server-held values",
  // Picks the shared Slack client when an account's configured bot token is
  // the env one. Routing between stored tokens, no caller input.
  "lib/server/watchdog-notify.js::botToken === String": "routes between stored Slack tokens",
  "lib/server/watchdog-notify.js::botToken === String#2": "routes between stored Slack tokens",
  // Watchdog exit-probe generation counter, named "token" but not a secret.
  "lib/server/watchdog.js::token !== pendingExitProbeToken": "generation counter, not a credential",
  "lib/server/watchdog.js::probeToken === pendingExitProbeToken": "generation counter, not a credential",
  "lib/server/watchdog.js::generationAtSettle !== pendingExitProbeToken": "generation counter, not a credential",
};

const kRoots = ["lib/server", "lib/cli", "lib/scripts", "lib/plugin", "lib/setup", "bin"];

describe("guard: secrets are compared in constant time", () => {
  it("flags raw comparisons on secret-named operands (self-test)", () => {
    const fixture = [
      "if (expectedToken !== receivedToken) deny();",
      "if (req.query.token === process.env.WEBHOOK_TOKEN) allow();",
      "if (signature == expected) allow();",
      "if (callbackSessionHash !== flow.sessionTokenHash) deny();",
      "if (submitted != SETUP_PASSWORD) deny();",
      "if (header === apiKey) allow();",
    ].join("\n");
    const keys = scanSecretCompares(fixture, "lib/server/planted.js").map((hit) => hit.key);
    expect(keys).toEqual([
      "lib/server/planted.js::expectedToken !== receivedToken",
      "lib/server/planted.js::req.query.token === process.env.WEBHOOK_TOKEN",
      "lib/server/planted.js::signature == expected",
      "lib/server/planted.js::callbackSessionHash !== flow.sessionTokenHash",
      "lib/server/planted.js::submitted != SETUP_PASSWORD",
      "lib/server/planted.js::header === apiKey",
    ]);
  });

  it("flags direct crypto.timingSafeEqual outside the helper (self-test)", () => {
    const fixture = "return a.length === b.length && crypto.timingSafeEqual(a, b);";
    expect(scanSecretCompares(fixture, "lib/server/planted.js").map((hit) => hit.key)).toEqual([
      "lib/server/planted.js::crypto.timingSafeEqual",
    ]);
    expect(scanSecretCompares(fixture, "lib/server/utils/timing-safe.js")).toEqual([]);
  });

  it("ignores literals, shape checks, non-secret names and comments (self-test)", () => {
    const fixture = [
      'if (typeof token !== "string") return;',
      'if (credential.mode === "password") return;',
      "if (token === null || secret !== undefined) return;",
      "if (totalTokens !== left.totalTokens) sort();",
      "if (name !== kSessionCookieName) keep();",
      "if (previousHash !== currentHash) changed();",
      "if (kTokenReadCache.tokenPath === tokenPath) hit();",
      "// if (expectedToken !== receivedToken) deny();",
    ].join("\n");
    expect(scanSecretCompares(fixture, "lib/server/planted.js")).toEqual([]);
  });

  it("has no new raw secret comparisons outside the allowlist, and no stale allowlist entries", () => {
    const { unexpected, stale } = auditTree({
      roots: kRoots,
      scan: scanSecretCompares,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `New raw secret comparison(s). Use timingSafeStringEqual from lib/server/utils/timing-safe.js, or allowlist with a why-comment when no caller-supplied value is compared:\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(
      stale,
      `Allowlist entries no longer match — the offender was fixed, remove them:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});
