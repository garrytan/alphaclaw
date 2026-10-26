const { readEnvFile, normalizeEnvVars, normalizeEnvKey } = require("../../env");
const { isSensitiveKey } = require("../../helpers");
const {
  isAgentEditableEnvKey,
  isAgentProtectedEnvKey,
} = require("../../utils/env-keys");

// Body-aware tier for PUT /api/env (A1): setting/rotating a secret is a plain
// restart-tier write (D3a: the value is transmitted ONCE, no confirm dance
// that would retransmit it). Only CLEARING an existing secret-class key —
// payload omits it or blanks it — escalates to dangerous.
//
// Only agent-editable keys count: the route preserves reserved/managed/hidden
// keys server-side regardless of the payload, so omitting one is NOT a clear.
// Without this filter, any deployment holding a channel token in .env would
// escalate EVERY agent env write to dangerous (and hard-block with 409 when no
// admin target is configured).
const envUpdateTierResolver = (req) => {
  const vars = req?.body?.vars;
  if (!Array.isArray(vars)) return "restart"; // route will 400; keep base tier
  let current;
  try {
    current = readEnvFile();
  } catch {
    return "restart";
  }
  // Canonicalize keys AND values through the SAME normalizer the write path
  // uses (normalizeEnvVars → normalizeEnvKey), so tier resolution reasons
  // about the exact keys/values that will be persisted. Without this a padded
  // or linebroken protected key resolves to the base tier here yet writes
  // canonical — the launcher-repoint bypass. Keep NON-string keys in the set
  // (only drop null/undefined): normalizeEnvVars String()-coerces them just
  // as the write path does, so an array-wrapped protected key
  // ({"key":["CLAUDE_CODE_ROUTINE_URL"]}) is classified on its coerced form
  // instead of slipping through as base tier.
  const submitted = new Map(
    normalizeEnvVars(vars.filter((v) => v && v.key != null)).map(
      ({ key, value }) => [key, String(value ?? "")],
    ),
  );
  const currentMap = new Map(
    current.map(({ key, value }) => [key, String(value ?? "")]),
  );
  // Repointing the Claude Code launcher is an agent-hijack vector: any change
  // an agent makes to a protected key (set a new one, rotate, or clear via
  // omission) escalates to a dangerous-tier operator confirm. Checked across
  // the union of current + submitted so an omitted-and-thus-deleted key is
  // caught too. Human writes bypass tiers entirely, so this gates only the
  // agent actor.
  for (const key of new Set([...currentMap.keys(), ...submitted.keys()])) {
    if (!isAgentProtectedEnvKey(key)) continue;
    const before = currentMap.get(key) ?? "";
    const after = submitted.get(key) ?? "";
    if (before !== after) return "dangerous";
  }
  for (const { key, value } of current) {
    if (!value || !isSensitiveKey(key) || !isAgentEditableEnvKey(key)) continue;
    const next = submitted.get(key);
    if (next === undefined || next === "") return "dangerous";
  }
  return "restart";
};

// The keys a PUT would delete: currently-set agent-editable keys the body
// omits or blanks. Names only; the confirm summary says how many and which.
const listEnvUpdateDeletions = (req) => {
  const vars = req?.body?.vars;
  if (!Array.isArray(vars)) return [];
  const submitted = new Map(
    normalizeEnvVars(vars.filter((v) => v && v.key != null)).map(
      ({ key, value }) => [key, String(value ?? "")],
    ),
  );
  return readEnvFile()
    .filter(({ key, value }) => value && isAgentEditableEnvKey(key) && !submitted.get(key))
    .map(({ key }) => key)
    .sort();
};

const kSummaryKeyLimit = 10;

const envUpdateConfirmSummary = (req) => {
  const deleted = listEnvUpdateDeletions(req);
  if (!deleted.length) return null;
  const shown = deleted.slice(0, kSummaryKeyLimit).join(", ");
  const more = deleted.length > kSummaryKeyLimit ? ` and ${deleted.length - kSummaryKeyLimit} more` : "";
  return `Replace environment variables: would delete ${deleted.length} key${deleted.length === 1 ? "" : "s"} (${shown}${more})`;
};

const readPatchTarget = (req) => {
  const body = req?.body || {};
  const key = normalizeEnvKey(body.key);
  return { key, isDelete: body.delete === true, next: body.delete === true ? "" : String(body.value ?? "") };
};

// Same escalation rules as PUT, for one key: changing a protected launcher
// key, or deleting/blanking an existing secret-class key, is dangerous.
const envPatchTierResolver = (req) => {
  const { key, next } = readPatchTarget(req);
  if (!key) return "restart";
  const before = readEnvFile().find((entry) => entry.key === key)?.value ?? "";
  if (isAgentProtectedEnvKey(key) && before !== next) return "dangerous";
  if (before && !next && isSensitiveKey(key) && isAgentEditableEnvKey(key)) return "dangerous";
  return "restart";
};

const envPatchConfirmSummary = (req) => {
  const { key, isDelete } = readPatchTarget(req);
  if (!key) return null;
  return isDelete ? `Delete environment variable ${key}` : `Set environment variable ${key}`;
};

// Agent-actor read redaction (U1.9): keys + present/absent only — values
// never enter the transcript. Redaction is hygiene, not secrecy (threat model).
const redactEnvList = (body) => ({
  ...body,
  vars: Array.isArray(body?.vars)
    ? body.vars.map(({ value, ...rest }) => ({
        ...rest,
        present: Boolean(value),
      }))
    : body?.vars,
});

module.exports = {
  domain: "env",
  title: "Environment Variables",
  summary: "List, replace, set or delete env vars (values masked); processes still on an old value",
  ops: [
    {
      id: "env.list",
      title: "List env vars (values masked)",
      method: "GET",
      path: "/api/env",
      tier: "safe",
      redactResponse: redactEnvList,
      notes:
        "Reserved/system keys and managed channel tokens never appear. `present: true` means a value is set.",
    },
    {
      id: "env.update",
      title: "Replace all env vars",
      method: "PUT",
      path: "/api/env",
      tier: "restart",
      tierResolver: envUpdateTierResolver,
      confirmSummary: envUpdateConfirmSummary,
      restart: "marks",
      readOp: "env.list",
      params: {
        fields: [
          {
            name: "vars",
            location: "body",
            type: "array<{key, value}>",
            required: true,
            description:
              "The FULL editable set. Omitting a currently-set editable key DELETES it — send everything you want kept, or use PATCH /api/env for one key. Reserved/system keys are skipped (see `skipped`); managed channel tokens are preserved server-side. Clearing an existing secret-class key escalates to a dangerous-tier confirm.",
          },
        ],
        example:
          '{"vars":[{"key":"ANTHROPIC_API_KEY","value":"sk-ant-..."},{"key":"BRAVE_API_KEY","value":""}]}',
      },
      hint: "Secrets via --data-stdin.",
      notes:
        "Marks restart-required; channel add/remove sync and auth-profile sync run server-side. Returns `staleProcesses` for changed keys.",
    },
    {
      id: "env.patch",
      title: "Set or delete one env var",
      method: "PATCH",
      path: "/api/env",
      tier: "restart",
      tierResolver: envPatchTierResolver,
      confirmSummary: envPatchConfirmSummary,
      restart: "marks",
      readOp: "env.list",
      params: {
        fields: [
          { name: "key", location: "body", type: "string", required: true, description: "The variable name ([A-Za-z0-9_])." },
          { name: "value", location: "body", type: "string", required: false, description: "The new value. Send this or delete." },
          { name: "delete", location: "body", type: "boolean", required: false, description: "true removes the key. Send this or value." },
        ],
        example: '{"key":"BRAVE_API_KEY","value":"..."}',
      },
      notes:
        "Other keys are untouched. Reserved/managed keys are refused (400). Deleting an existing secret escalates to a confirm. Response as PUT.",
    },
    {
      id: "env.stale-processes",
      title: "Processes on an old env value",
      method: "GET",
      path: "/api/env/stale-processes",
      tier: "safe",
      params: {
        fields: [
          { name: "keys", location: "query", type: "string", required: false, description: "Comma-separated key names; default every key in .env." },
        ],
      },
      notes:
        "Hash-compares /proc/<pid>/environ of same-user processes; never returns values. state: differs, still_set (deleted from .env), missing (gateway lacks a launched key).",
    },
  ],
};
