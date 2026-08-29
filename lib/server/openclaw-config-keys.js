// Shared config key-path machinery for every AlphaClaw repair surface: the
// gateway medic (exit-78 reactive) and the boot config reconciler (proactive)
// parse the same validator/stderr blame lines and remove keys with the same
// guarded walk. ONE parser, ONE protected-path denylist, ONE
// prototype-pollution guard — two drifting copies of security-relevant logic
// is how a denylist gap ships (issue #20 review, finding F1).
//
// Callers own: file locking (updateOpenclawConfig), pre-removal backups, and
// any caller-specific skip policy (the medic re-checks managed-stripe
// hand-set-ness; the reconciler skips everything not explicitly blamed).

// Matches the gateway's error line forms ('gateway.controlUi: Unrecognized
// key: "environment"', 'Unrecognized key: "audit"') and the doctor/preflight
// bullet form ("  - gateway.controlUi: Invalid input"). Anchored to LINE
// START on purpose: stderr is untrusted, and a validator echoing an
// attacker-shaped config value mid-line ('received "gateway: Unrecognized
// key: \"auth\""') must not mint a removable path.
// Both the singular and the plural line shapes are real: issue #20's gateway
// printed 'agents.defaults.compaction: Unrecognized keys: "a", "b", "c"'.
const kUnrecognizedKeyPattern =
  /^\s*(?:-\s*)?(?:([A-Za-z0-9_.$[\]-]+):\s*)?Unrecognized keys?:?\s*"([^"]+)"((?:\s*,\s*"[^"]+")*)/;
const kInvalidValuePattern =
  /^\s*(?:-\s*)?([A-Za-z0-9_.$[\]-]+):\s*(Invalid (?:input|value|type).*|Expected .*|Required.*)$/;

// Security-critical config subtrees are NEVER auto-removable, no matter what
// the gateway's stderr blames or a model proposes: deleting them can default
// a control open (gateway.auth removal flips a team-mode gateway back to
// token auth). Doctor/manual repair own these.
const kProtectedKeyPathPrefixes = [
  "gateway.auth",
  "gateway.trustedProxies",
  "gateway.controlUi.allowedOrigins",
  "auth",
  "team",
  "members",
];
const isProtectedKeyPath = (keyPath) =>
  kProtectedKeyPathPrefixes.some(
    (prefix) =>
      keyPath === prefix ||
      keyPath.startsWith(`${prefix}.`) ||
      // Removing an ANCESTOR ("gateway", "gateway.controlUi") deletes the
      // protected child with it — the exact fail-open the denylist prevents.
      prefix.startsWith(`${keyPath}.`),
  );

const extractBlamedConfigPaths = (stderrLines = []) => {
  const unrecognized = [];
  const invalid = [];
  const seen = new Set();
  for (const line of Array.isArray(stderrLines) ? stderrLines : []) {
    const text = String(line || "");
    const keyMatch = text.match(kUnrecognizedKeyPattern);
    if (keyMatch) {
      const [, section, firstKey, restKeys] = keyMatch;
      const keys = [
        firstKey,
        ...(restKeys ? [...restKeys.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []),
      ];
      for (const key of keys) {
        const keyPath = section ? `${section}.${key}` : key;
        if (!seen.has(keyPath)) {
          seen.add(keyPath);
          unrecognized.push(keyPath);
        }
      }
      continue;
    }
    const valueMatch = text.match(kInvalidValuePattern);
    if (valueMatch) {
      const [, keyPath, problem] = valueMatch;
      if (!seen.has(keyPath)) {
        seen.add(keyPath);
        invalid.push({ path: keyPath, problem: problem.trim() });
      }
    }
  }
  return { unrecognized, invalid };
};

// Key paths originate in UNTRUSTED gateway stderr; a crafted line like
// `__proto__: Unrecognized key: "toString"` must never let the walk reach
// Object.prototype or delete inherited properties.
const kUnsafePathSegments = new Set(["__proto__", "constructor", "prototype"]);

// Removes key paths from a parsed config OBJECT (caller holds the lock and
// re-serializes). Behavior contract, preserved verbatim from the medic:
//  - skipKeyPath(keyPath, config) → true skips (caller policy: managed-stripe
//    re-checks, protected prefixes, …). Fail closed in your callback.
//  - a ROOT key whose NAME contains dots ('channels.telegram.enabled' as a
//    literal key) is deleted literally — splitting it into a path would
//    delete an unrelated nested setting instead.
//  - onBeforeFirstRemoval(config) fires once, before the first mutation —
//    the caller's backup hook, serialized from the locked object.
//  - now-empty parent objects are pruned so a strict-root schema never sees
//    a leftover empty section it doesn't know.
// Returns the array of key paths actually removed.
const removeKeyPathsFromConfigObject = (
  config,
  keyPaths,
  { skipKeyPath = () => false, onBeforeFirstRemoval = () => {} } = {},
) => {
  const removed = [];
  let firstRemovalHandled = false;
  const beforeRemoval = () => {
    if (!firstRemovalHandled) {
      firstRemovalHandled = true;
      onBeforeFirstRemoval(config);
    }
  };
  for (const keyPath of Array.isArray(keyPaths) ? keyPaths : []) {
    let skip = true;
    try {
      skip = Boolean(skipKeyPath(keyPath, config));
    } catch {
      skip = true;
    }
    if (skip) continue;
    if (
      !kUnsafePathSegments.has(keyPath) &&
      config &&
      typeof config === "object" &&
      Object.hasOwn(config, keyPath)
    ) {
      beforeRemoval();
      delete config[keyPath];
      removed.push(keyPath);
      continue;
    }
    const segments = String(keyPath).split(".");
    const leaf = segments.pop();
    if (
      leaf === undefined ||
      [...segments, leaf].some((segment) => kUnsafePathSegments.has(segment))
    ) {
      continue;
    }
    let parent = config;
    const chain = [{ node: config, key: null }];
    let traversable = true;
    for (const segment of segments) {
      if (
        !parent ||
        typeof parent !== "object" ||
        !Object.hasOwn(parent, segment)
      ) {
        traversable = false;
        break;
      }
      parent = parent[segment];
      chain.push({ node: parent, key: segment });
    }
    if (
      !traversable ||
      !parent ||
      typeof parent !== "object" ||
      !Object.hasOwn(parent, leaf)
    ) {
      continue;
    }
    beforeRemoval();
    delete parent[leaf];
    removed.push(keyPath);
    for (let i = chain.length - 1; i >= 1; i -= 1) {
      const { node, key } = chain[i];
      const owner = chain[i - 1].node;
      if (
        node &&
        typeof node === "object" &&
        !Array.isArray(node) &&
        Object.keys(node).length === 0
      ) {
        delete owner[key];
      } else {
        break;
      }
    }
  }
  return removed;
};

module.exports = {
  kUnrecognizedKeyPattern,
  kInvalidValuePattern,
  kProtectedKeyPathPrefixes,
  isProtectedKeyPath,
  extractBlamedConfigPaths,
  kUnsafePathSegments,
  removeKeyPathsFromConfigObject,
};
