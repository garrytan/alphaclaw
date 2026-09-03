const { readEnvFile, normalizeEnvVars } = require("../../env");
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
  ops: [
    {
      id: "env.list",
      title: "List environment variables (values masked to present/absent)",
      method: "GET",
      path: "/api/env",
      tier: "safe",
      redactResponse: redactEnvList,
      notes:
        "Reserved/system keys and managed channel tokens never appear. `present: true` means a value is set.",
    },
    {
      id: "env.update",
      title: "Set/update environment variables",
      method: "PUT",
      path: "/api/env",
      tier: "restart",
      tierResolver: envUpdateTierResolver,
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
              "The FULL editable set. Omitting a currently-set editable key DELETES it — send everything you want kept. Reserved/system keys are rejected (400); managed channel tokens are preserved server-side. Clearing an existing secret-class key escalates to a dangerous-tier confirm.",
          },
        ],
        example:
          '{"vars":[{"key":"ANTHROPIC_API_KEY","value":"sk-ant-..."},{"key":"BRAVE_API_KEY","value":""}]}',
      },
      hint: "Pipe secret-bearing bodies via --data-stdin so values stay out of process args.",
      notes:
        "Marks restart-required; channel add/remove sync and auth-profile sync run server-side.",
    },
  ],
};
