const crypto = require("crypto");

// The agent-admin operation manifest: the single source of truth for
// agent-facing POLICY (tiers, redaction, docs, hints). Route handlers keep
// owning validation and behavior — the manifest never duplicates them.
// Three consumers: the enforcement middleware, GET /api/admin/manifest, and
// the generated SKILL.md operation tables.

const kTiers = Object.freeze(["safe", "write", "restart", "dangerous", "denied"]);
const kMethods = Object.freeze(["GET", "POST", "PUT", "DELETE", "PATCH"]);
const kEnvelopes = Object.freeze(["legacy", "structured"]);
const kRestarts = Object.freeze(["none", "marks", "restarts"]);
const kIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const kParamLocations = Object.freeze(["body", "query", "path"]);

// Tiny spec'd pattern compiler (deliberately NOT path-to-regexp — it is not a
// direct dependency and our grammar is just static segments + `:param`).
// Matching happens on req.baseUrl + req.path: Express trims the mount prefix,
// so req.path alone would be "/env" under app.use("/api", ...) (A19).
const compilePathPattern = (opPath) => {
  if (typeof opPath !== "string" || !opPath.startsWith("/api/")) {
    throw new Error(`admin-manifest: path must start with /api/: ${opPath}`);
  }
  const segments = opPath.split("/").slice(1);
  const parts = segments.map((segment) => {
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
        throw new Error(
          `admin-manifest: invalid :param segment "${segment}" in ${opPath}`,
        );
      }
      return "[^/]+";
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error(
        `admin-manifest: invalid path segment "${segment}" in ${opPath}`,
      );
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^/${parts.join("/")}$`);
};

const validateParams = (op) => {
  if (op.params === undefined) return;
  const fields = op.params?.fields;
  if (!Array.isArray(fields)) {
    throw new Error(`admin-manifest: ${op.id}: params.fields must be an array`);
  }
  for (const field of fields) {
    if (!field?.name || typeof field.name !== "string") {
      throw new Error(`admin-manifest: ${op.id}: param field needs a name`);
    }
    if (!kParamLocations.includes(field.location)) {
      throw new Error(
        `admin-manifest: ${op.id}: param "${field.name}" needs location body|query|path`,
      );
    }
  }
};

const validateOp = (op, seenIds) => {
  if (!op || typeof op !== "object") throw new Error("admin-manifest: bad op");
  if (!kIdPattern.test(String(op.id || ""))) {
    throw new Error(`admin-manifest: invalid op id: ${op.id}`);
  }
  if (seenIds.has(op.id)) {
    throw new Error(`admin-manifest: duplicate op id: ${op.id}`);
  }
  seenIds.add(op.id);
  if (!kMethods.includes(op.method)) {
    throw new Error(`admin-manifest: ${op.id}: invalid method ${op.method}`);
  }
  if (!kTiers.includes(op.tier)) {
    throw new Error(`admin-manifest: ${op.id}: invalid tier ${op.tier}`);
  }
  if (op.tierResolver !== undefined && typeof op.tierResolver !== "function") {
    throw new Error(`admin-manifest: ${op.id}: tierResolver must be a function`);
  }
  if (op.redactResponse !== undefined && typeof op.redactResponse !== "function") {
    throw new Error(`admin-manifest: ${op.id}: redactResponse must be a function`);
  }
  if (op.envelope !== undefined && !kEnvelopes.includes(op.envelope)) {
    throw new Error(`admin-manifest: ${op.id}: invalid envelope ${op.envelope}`);
  }
  if (op.restart !== undefined && !kRestarts.includes(op.restart)) {
    throw new Error(`admin-manifest: ${op.id}: invalid restart ${op.restart}`);
  }
  if (!op.title || typeof op.title !== "string") {
    throw new Error(`admin-manifest: ${op.id}: title required`);
  }
  validateParams(op);
};

const kDomainModules = [
  require("./domains/system"),
  require("./domains/env"),
  require("./domains/models"),
  require("./domains/usage"),
  require("./domains/codex"),
  require("./domains/channels"),
  require("./domains/agents"),
  require("./domains/telegram"),
  require("./domains/google"),
  require("./domains/gmail"),
  require("./domains/cron"),
  require("./domains/webhooks"),
  require("./domains/nodes"),
  require("./domains/watchdog"),
  require("./domains/claude-code"),
  require("./domains/updates"),
  require("./domains/notifications"),
  require("./domains/team"),
  require("./domains/browse"),
  require("./domains/doctor"),
  require("./domains/admin"),
];

// Routes deliberately NOT in the manifest. Every entry needs a why-comment —
// the route-coverage test fails on any /api route that is neither classified
// here nor covered by a descriptor.
const kUnmanifestedRoutes = new Set([
  // Auth bootstrap: the bearer path must never mint/destroy cookie sessions.
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "GET /api/auth/status",
  // Team-mode session bootstrap (main's 4.x invite flow): accept-invite mints a
  // member session cookie from an invite token, identity reports the current
  // session's role — both are human session plumbing, never agent-driven.
  "POST /api/auth/accept-invite",
  "GET /api/auth/identity",
  // Deliberately unauthenticated operator-picker metadata.
  "GET /api/team/login-info",
  // Onboarding is a human bootstrap flow (denied as a namespace; individual
  // routes are numerous and change with the wizard — blanket-denied by A20's
  // deny-outside-manifest rule, listed here for the coverage test).
  "ALL /api/onboard/*",
]);

let kCompiled = null;

const buildManifest = () => {
  if (kCompiled) return kCompiled;
  const seenIds = new Set();
  const ops = [];
  for (const domainModule of kDomainModules) {
    const { domain, title, ops: domainOps } = domainModule;
    if (!domain || !Array.isArray(domainOps)) {
      throw new Error("admin-manifest: domain module needs {domain, ops[]}");
    }
    for (const op of domainOps) {
      const full = { envelope: "legacy", restart: "none", ...op, domain };
      validateOp(full, seenIds);
      ops.push({
        ...full,
        domainTitle: title || domain,
        pathPattern: compilePathPattern(full.path),
        // GETs are idempotent by nature; writes must opt in explicitly (A32).
        idempotent:
          full.idempotent !== undefined ? full.idempotent === true : full.method === "GET",
      });
    }
  }
  // manifestVersion: content hash over the serializable projection, so any
  // descriptor change is visible to the CLI/skill staleness checks (A30/A39).
  const serialized = JSON.stringify(ops.map(serializeOp));
  const manifestVersion = crypto
    .createHash("sha256")
    .update(serialized)
    .digest("hex")
    .slice(0, 12);
  kCompiled = { ops, manifestVersion };
  return kCompiled;
};

// Projection safe for JSON transport (functions and regexes stripped).
const serializeOp = (op) => ({
  id: op.id,
  domain: op.domain,
  title: op.title,
  method: op.method,
  path: op.path,
  tier: op.tier,
  bodyAwareTier: typeof op.tierResolver === "function" || undefined,
  restart: op.restart,
  envelope: op.envelope,
  idempotent: op.idempotent,
  streaming: op.streaming || undefined,
  deprecated: op.deprecated || undefined,
  undoable: op.undoable || undefined,
  params: op.params,
  readOp: op.readOp,
  async: op.async,
  secretFields: op.secretFields,
  hint: op.hint,
  enableHint: op.enableHint,
  notes: op.notes,
});

const getManifest = () => {
  const { ops, manifestVersion } = buildManifest();
  return {
    manifestVersion,
    ops: ops.map(serializeOp),
  };
};

const getManifestVersion = () => buildManifest().manifestVersion;

// Exactly-one-match is enforced by tests (literal-vs-:param collisions fail
// CI); at runtime first-match wins over a list ordered by registration.
const findOp = (method, fullPath) => {
  const { ops } = buildManifest();
  const normalizedMethod = String(method || "").toUpperCase();
  for (const op of ops) {
    if (op.method !== normalizedMethod) continue;
    if (op.pathPattern.test(fullPath)) return op;
  }
  return null;
};

const findAllOps = (method, fullPath) => {
  const { ops } = buildManifest();
  const normalizedMethod = String(method || "").toUpperCase();
  return ops.filter(
    (op) => op.method === normalizedMethod && op.pathPattern.test(fullPath),
  );
};

// Body-aware tier resolution (A1): PUT /api/env is dangerous only when the
// payload clears an existing secret-class key, etc.
const resolveTier = (op, req) => {
  if (typeof op.tierResolver === "function") {
    try {
      const resolved = op.tierResolver(req);
      if (kTiers.includes(resolved)) return resolved;
    } catch {
      // Fail CLOSED: a resolver exists only to ESCALATE (browse read → denied,
      // env clear → dangerous). Falling back to op.tier would silently apply
      // the LESS restrictive base tier — the wrong direction for a guard. A
      // throwing resolver forces a confirm instead.
      return "dangerous";
    }
  }
  return op.tier;
};

const listOps = () => buildManifest().ops;

module.exports = {
  kTiers,
  kUnmanifestedRoutes,
  compilePathPattern,
  findOp,
  findAllOps,
  getManifest,
  getManifestVersion,
  listOps,
  resolveTier,
  serializeOp,
};
