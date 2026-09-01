const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { kDoctorCardSource } = require("./constants");
const {
  canonicalizeAnthropicModelId,
  getAnthropicRegistryEntry,
  findNewerSameTierEntry,
  validateRegistryOntology,
} = require("./model-registry");

// Model-drift checks: no LLM, no gateway — pure reads over the openclaw.json
// snapshot, the model catalog rows, and the workspace skills tree, recomputed
// on EVERY run like the sibling deterministic checks. Card safety rules are
// identical: fixPrompts are template-built, and only token-shaped values
// (model keys/ids, skill locations) may be interpolated into them; anything
// else is display-only and passes the injected sanitizer.

// Model keys that may enter an agent-dispatched fixPrompt: no
// whitespace/control chars, bounded length. `:`/`@` stay allowed here —
// real model keys carry them (ollama `:cloud`, Vertex `@date`).
const kSafeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
// Skill locations are held to a tighter charset before fixPrompt
// interpolation: legitimate skill directory paths never need `:`/`@`, and
// dropping them shrinks the prompt-shaping surface of hostile dir names.
const kSafeLocationPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
// Raw locations longer than this key on a content hash instead — a path
// crossing the bound must not silently mint a new sourceKey per character
// (mirrors kSourceKeyPathMaxChars in deterministic-checks.js).
const kSourceKeyLocationMaxChars = 100;
// A well-formed catalog model key is provider/model (nested paths allowed).
const kModelKeyPattern = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const kDisplayTextMaxChars = 300;
const kMaxInvalidBindingCards = 6;
const kMaxSkillCards = 8;
const kMaxViolationEvidenceLines = 10;
// Mirrors the deterministic skills-scan bounds (upstream's own discovery
// caps) so a pathological skills/ tree cannot stall a run.
const kSkillsScanMaxDepth = 6;
const kSkillsScanMaxCandidates = 300;
const kSkillsScanMaxVisitedDirents = 10000;
// Upstream reads at most 256KB of a SKILL.md; scanning past that would flag
// text the agent never sees. The TOTAL budget bounds the whole pass (this
// scan reads full skill bodies, unlike the sibling frontmatter scan) so the
// worst case is ~8MB of synchronous IO, not candidates × 256KB — mirrors the
// kSnippetScanMaxBytes doctrine in service.js.
const kSkillReadMaxBytes = 256 * 1024;
const kSkillsScanMaxTotalReadBytes = 8 * 1024 * 1024;
// Sane bounds for a declared max context size: below 1k tokens is not a
// working coding model; above 20M is beyond any shipped context window.
const kContextWindowMinTokens = 1024;
const kContextWindowMaxTokens = 20000000;
// First-party surfaces where Anthropic's documented limits apply verbatim.
// Gateway/proxy providers (openrouter, vercel-ai-gateway, …) legitimately
// re-cap context per plan/entitlement — comparing them against first-party
// limits would emit false positives.
const kFirstPartyAnthropicProviders = new Set(["anthropic", "claude-cli"]);

// 96 bits of digest: sourceKeys gate dismissal suppression by exact match,
// and a 48-bit truncation over attacker-influenced input (config keys, skill
// paths) would leave second-preimage suppression GPU-feasible.
const shortHash = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24);

const isSafeToken = (value) => kSafeTokenPattern.test(String(value || ""));

// Every claude-* coded id in a text blob (dot or dash notation, optional
// provider/date decorations) — each match is canonicalized individually
// (the canonicalizer re-applies its own boundary guards).
const kEmbeddedModelIdPattern =
  /claude-(?:opus|sonnet|haiku|fable|mythos)(?:[.-]\d+)+(?:-20\d{6})?|claude-\d(?:[.-]\d)?-(?:opus|sonnet|haiku)(?:-20\d{6})?/g;

// ── Configured bindings ────────────────────────────────────────────────────

// Flatten every model binding in openclaw.json into {scope, role, key} rows.
// Scopes: "defaults" plus each agents.list entry; roles: "primary",
// "fallback", and "enabled" (a key of the scope's models map).
const collectConfiguredModels = (config) => {
  const rows = [];
  const addScope = (scopeName, scope) => {
    if (!scope || typeof scope !== "object") return;
    // Upstream also accepts the string shorthand `model: "provider/model"`
    // (see use-model-card.js) — treat it as the primary binding.
    const primary = String(
      (typeof scope.model === "string" ? scope.model : scope.model?.primary) || "",
    ).trim();
    if (primary) rows.push({ scope: scopeName, role: "primary", key: primary });
    const fallbacks = Array.isArray(scope.model?.fallbacks)
      ? scope.model.fallbacks
      : scope.model?.fallback
        ? [scope.model.fallback]
        : [];
    for (const fallback of fallbacks) {
      const key = String(fallback || "").trim();
      if (key) rows.push({ scope: scopeName, role: "fallback", key });
    }
    const models = scope.models;
    if (models && typeof models === "object" && !Array.isArray(models)) {
      for (const key of Object.keys(models)) {
        const trimmed = String(key || "").trim();
        if (trimmed) rows.push({ scope: scopeName, role: "enabled", key: trimmed });
      }
    }
  };
  addScope("defaults", config?.agents?.defaults);
  const agentList = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  agentList.forEach((entry, index) => {
    // Scope strings reach fixPrompts, so they are safe by construction: an
    // agent id that is not a plain identifier is referenced by position.
    const rawAgentId = String(entry?.id || "").trim();
    const agentId = /^[A-Za-z0-9._-]{1,64}$/.test(rawAgentId)
      ? rawAgentId
      : `#${index}`;
    addScope(`agent ${agentId}`, entry);
  });
  return rows;
};

// Catalog index: canonical Anthropic id → catalog keys that resolve to it,
// the plain key set, the set of providers the catalog view carries at all,
// and the set of available canonical ids.
const indexCatalog = (catalogModels) => {
  const keys = new Set();
  const providers = new Set();
  const keysByCanonicalId = new Map();
  const canonicalIdsByProvider = new Map();
  for (const row of Array.isArray(catalogModels) ? catalogModels : []) {
    const key = String(row?.key || "").trim();
    if (!key) continue;
    keys.add(key);
    const provider = key.split("/")[0];
    providers.add(provider);
    // A row the CLI marks unavailable still counts for catalog MEMBERSHIP
    // (binding it is not a typo) but never as a successor candidate — a fix
    // prompt must not rewrite a binding onto a model the gateway can't run.
    if (row?.available === false) continue;
    const canonicalId = canonicalizeAnthropicModelId(key);
    if (!canonicalId) continue;
    if (!keysByCanonicalId.has(canonicalId)) keysByCanonicalId.set(canonicalId, []);
    keysByCanonicalId.get(canonicalId).push(key);
    if (!canonicalIdsByProvider.has(provider)) {
      canonicalIdsByProvider.set(provider, new Set());
    }
    canonicalIdsByProvider.get(provider).add(canonicalId);
  }
  return {
    keys,
    providers,
    keysByCanonicalId,
    canonicalIdsByProvider,
    availableCanonicalIds: new Set(keysByCanonicalId.keys()),
  };
};

// A successor key is only named on the SAME provider as the binding being
// replaced — recommending anthropic/claude-opus-5 to a claude-cli or
// openrouter binding would silently move the workload onto different
// credentials/billing. Undated base keys beat dated snapshot aliases.
const pickSuccessorKey = (successorEntry, catalogIndex, configuredProvider) => {
  if (!successorEntry) return "";
  const candidates = (
    catalogIndex.keysByCanonicalId.get(successorEntry.id) || []
  ).filter((key) => key.split("/")[0] === configuredProvider);
  if (!candidates.length) return "";
  return (
    candidates.find((key) => key === `${configuredProvider}/${successorEntry.id}`) ||
    candidates[0]
  );
};

const buildBindingDriftCards = ({ configuredRows, catalogIndex, addCard, sanitize }) => {
  const configured = configuredRows;
  // Keys come verbatim from openclaw.json: display-safe only after the
  // sanitizer (a key can embed a real model id AND control chars).
  const displayKey = (key) =>
    sanitize(key, { maxChars: kDisplayTextMaxChars, singleLine: true });
  // Group by canonical Anthropic id; non-Anthropic keys are handled by the
  // invalid-coding check only (the registry has no authority over them).
  const byCanonicalId = new Map();
  for (const row of configured) {
    const entry = getAnthropicRegistryEntry(row.key);
    if (!entry) continue;
    if (!byCanonicalId.has(entry.id)) {
      byCanonicalId.set(entry.id, { entry, rows: [] });
    }
    byCanonicalId.get(entry.id).rows.push(row);
  }
  for (const { entry, rows } of byCanonicalId.values()) {
    const scopesLine = rows
      .map((row) => `${row.scope} (${row.role}: ${displayKey(row.key)})`)
      .slice(0, kMaxViolationEvidenceLines)
      .join("; ");
    const primaryRow = rows.find((row) => row.role === "primary");
    const idealSuccessor = findNewerSameTierEntry(entry);
    // Distinct provider prefixes across the rows: a successor KEY is only
    // interpolated when exactly one provider is involved — a mixed-provider
    // group gets the generic prompt so one provider's key never rewrites
    // another provider's binding.
    const rowProviders = new Set(rows.map((row) => row.key.split("/")[0]));
    // Availability is judged on the SAME provider for single-provider
    // groups: "Opus 5 is available" must not mean "on some other provider
    // with different credentials". Mixed groups fall back to the global view
    // (they already get the generic prompt).
    const availableSuccessor = findNewerSameTierEntry(
      entry,
      rowProviders.size === 1
        ? catalogIndex.canonicalIdsByProvider.get(
            rowProviders.values().next().value,
          ) || new Set()
        : catalogIndex.availableCanonicalIds,
    );
    const pickedSuccessorKey =
      rowProviders.size === 1
        ? pickSuccessorKey(
            availableSuccessor,
            catalogIndex,
            rowProviders.values().next().value,
          )
        : "";
    // ONE gate for every surface the key reaches: the catalog is only
    // semi-trusted (custom models.providers entries surface in it), so a
    // key failing the token shape is named NOWHERE — not in the dispatched
    // fixPrompt and not in the UI-rendered recommendation either.
    const successorKey = isSafeToken(pickedSuccessorKey) ? pickedSuccessorKey : "";
    const evidence = rows.slice(0, kMaxViolationEvidenceLines).map((row) => ({
      type: "text",
      text: `${row.scope}: ${row.role} = ${displayKey(row.key)}`,
    }));
    if (entry.status === "deprecated") {
      addCard({
        // Severity lives in the sourceKey (repo doctrine: dismissing a mild
        // card must never suppress a later, more severe one for the same
        // subject — see det:memory-budget / det:hardening).
        sourceKey: `det:model-drift:binding-deprecated:${entry.id}`,
        priority: "P1",
        category: "model drift",
        title: `Configured model ${entry.label} is outdated — switch off it`,
        summary:
          `openclaw.json still binds ${entry.label} (${entry.id}), a deprecated model that newer ` +
          `Anthropic releases clearly outperform. Bound at: ${scopesLine}.`,
        recommendation: availableSuccessor
          ? `Move to ${availableSuccessor.label}${successorKey ? ` (\`${successorKey}\`)` : ""} — ` +
            `it is available in the installed model catalog.`
          : idealSuccessor
            ? `Move to ${idealSuccessor.label} (${idealSuccessor.id}). The installed OpenClaw's catalog ` +
              `does not list it yet — upgrade OpenClaw, then switch the binding.`
            : `Move to a current-generation Anthropic model.`,
        evidence,
        targetPaths: [],
        fixPrompt:
          successorKey
            ? `In openclaw.json, replace every agents model binding that uses the deprecated ` +
              `${entry.id} with ${successorKey} (agents.defaults.model / agents.list[].model / the ` +
              `models maps), then verify the agent still responds. Use \`openclaw models set\` where possible.`
            : `In openclaw.json, replace every agents model binding that uses the deprecated ` +
              `${entry.id} with the newest same-tier model offered on the SAME provider in ` +
              `\`openclaw models list\` (upgrade OpenClaw first if no newer model is listed), then ` +
              `verify the agent still responds.`,
      });
      continue;
    }
    // Registry doctrine: "current" models get no drift card by themselves
    // (a tier can carry several during a transition) — only LEGACY bindings
    // are nudged, only when a strictly newer same-tier model is actually
    // installed on the binding's provider, and only for primary bindings
    // (an enabled-models row is an allowlist entry, not what the agent
    // runs on).
    if (entry.status !== "legacy" || !primaryRow || !availableSuccessor) continue;
    addCard({
      sourceKey: `det:model-drift:binding-newer:${entry.id}`,
      priority: "P2",
      category: "model drift",
      title: `A newer ${entry.tier} model than ${entry.label} is available`,
      summary:
        `${primaryRow.scope} runs on ${entry.label} (${displayKey(primaryRow.key)}), but the installed ` +
        `catalog already lists ${availableSuccessor.label} — same tier, newer generation.`,
      recommendation:
        `Switch the primary model to ${availableSuccessor.label}` +
        `${successorKey ? ` (\`${successorKey}\`)` : ""} unless this binding is pinned deliberately.`,
      evidence,
      targetPaths: [],
      fixPrompt:
        successorKey
          ? `In openclaw.json, update the primary model binding(s) currently on ${entry.id} to ` +
            `${successorKey}, then verify the agent still responds. Use \`openclaw models set\` where possible.`
          : `In openclaw.json, update the primary model binding(s) currently on ${entry.id} to the ` +
            `newest same-tier model offered on the SAME provider in \`openclaw models list\`, then ` +
            `verify the agent still responds.`,
    });
  }
};

// Custom providers declare their own model list in openclaw.json — a key
// under one is validated against that declared list (when parseable), never
// against the CLI catalog.
// One normalization for a custom provider's model list (array OR object
// map) — the invalid-binding and context-window checks must never disagree
// about which models a provider declares.
const normalizeProviderModelDefs = (providerDef) => {
  const models = providerDef?.models;
  return Array.isArray(models)
    ? models
    : models && typeof models === "object"
      ? Object.entries(models).map(([id, def]) => ({ ...(def || {}), id }))
      : [];
};

const customProviderModelIds = (providerDef) => {
  const ids = new Set();
  for (const def of normalizeProviderModelDefs(providerDef)) {
    const id = String(def?.id || def?.name || "").trim();
    if (id) ids.add(id);
  }
  return ids;
};

const buildInvalidBindingCards = ({
  configuredRows,
  customProviders,
  catalogIndex,
  catalogSource,
  addCard,
  sanitize,
}) => {
  const configured = configuredRows;
  const staleHedge =
    catalogSource === "bootstrap"
      ? " (Judged against the bundled catalog snapshot — open the Models tab to refresh the live list before acting.)"
      : catalogSource === "cache"
        ? " (Judged against a cached catalog listing — refresh the Models tab for a live view before acting.)"
        : "";
  const seenKeys = new Set();
  // Capped-but-honest: past the card cap, findings are counted instead of
  // emitted, and the last emitted card carries the overflow (the skill cards
  // set the precedent — a silent cap reads as "everything else is clean").
  const emittedCards = [];
  let suppressed = 0;
  // Queue-then-flush: addCard copies its input, so the overflow note must be
  // attached BEFORE the cards leave this function.
  const emitCard = (card) => {
    if (emittedCards.length >= kMaxInvalidBindingCards) {
      suppressed += 1;
      return;
    }
    emittedCards.push(card);
  };
  for (const row of configured) {
    if (seenKeys.has(row.key)) continue;
    seenKeys.add(row.key);
    const displayKey = sanitize(row.key, {
      maxChars: kDisplayTextMaxChars,
      singleLine: true,
    });
    const malformed = !kModelKeyPattern.test(row.key);
    const provider = row.key.split("/")[0];
    const inCatalog = catalogIndex.keys.has(row.key);
    const registryEntry = getAnthropicRegistryEntry(row.key);
    const looksAnthropic =
      provider === "anthropic" ||
      provider === "claude-cli" ||
      /claude-/.test(row.key);
    if (malformed) {
      emitCard({
        sourceKey: `det:model-drift:invalid-malformed:${shortHash(row.key)}`,
        priority: "P1",
        category: "model drift",
        title: "A configured model key is not a valid model coding",
        summary:
          `openclaw.json (${row.scope}, ${row.role}) binds \`${displayKey}\`, which does not match ` +
          `the provider/model key grammar — the gateway cannot resolve it to any model.`,
        recommendation:
          "Replace it with an exact key from `openclaw models list` (format provider/model, e.g. " +
          "anthropic/claude-opus-5).",
        evidence: [{ type: "text", text: `${row.scope}: ${row.role} = ${displayKey}` }],
        targetPaths: [],
        fixPrompt:
          `An agents model binding in openclaw.json (scope: ${row.scope}, role: ${row.role}) holds a ` +
          `malformed model key. Replace it with an exact provider/model key from \`openclaw models list\`, ` +
          `then verify the agent still responds.`,
      });
      continue;
    }
    // Custom provider: validate against ITS declared model list when one is
    // parseable — BEFORE the catalog-membership skip, so a stale catalog row
    // can never mask a model that was removed from models.providers. An
    // empty/unparseable list means we cannot judge — exempt.
    if (Object.prototype.hasOwnProperty.call(customProviders, provider)) {
      const declaredIds = customProviderModelIds(customProviders[provider]);
      const modelPart = row.key.slice(provider.length + 1);
      if (declaredIds.size === 0 || declaredIds.has(modelPart)) continue;
      emitCard({
        sourceKey: `det:model-drift:invalid-undeclared:${shortHash(row.key)}`,
        priority: "P2",
        category: "model drift",
        title: `Configured model \`${displayKey}\` is not declared by its custom provider`,
        summary:
          `openclaw.json (${row.scope}, ${row.role}) binds \`${displayKey}\`, but the models.providers ` +
          `entry for "${sanitize(provider, { maxChars: 64, singleLine: true })}" does not declare that ` +
          `model id — likely a typo in the binding or a missing model entry.`,
        recommendation:
          "Fix the binding to a declared model id, or add the model under models.providers.",
        evidence: [{ type: "text", text: `${row.scope}: ${row.role} = ${displayKey}` }],
        targetPaths: [],
        fixPrompt:
          `A model binding in openclaw.json (scope: ${row.scope}, role: ${row.role}) names a model its ` +
          `custom provider does not declare. Reconcile the binding with the provider's models list under ` +
          `models.providers in openclaw.json, then verify the model loads with \`openclaw models list\`.`,
      });
      continue;
    }
    if (inCatalog) continue;
    // Catalog-miss flags need the catalog to actually SPEAK for that
    // provider: the live catalog filters whole providers out (e.g.
    // claude-cli), so a zero-row provider is "unjudgeable", not invalid.
    if (!catalogIndex.keys.size || !catalogIndex.providers.has(provider)) continue;
    // Anthropic-shaped key the ontology cannot classify either: almost
    // certainly a typo (e.g. a hallucinated version) — stronger than a
    // plain catalog miss, which can just mean a stale catalog.
    const unknownAnthropic = looksAnthropic && !registryEntry;
    emitCard({
      sourceKey: `det:model-drift:${unknownAnthropic ? "invalid-unknown" : "invalid-missing"}:${shortHash(row.key)}`,
      priority: unknownAnthropic ? "P1" : "P2",
      category: "model drift",
      title: unknownAnthropic
        ? `Configured model \`${displayKey}\` is not a known Anthropic model`
        : `Configured model \`${displayKey}\` is not in the installed model catalog`,
      summary:
        (unknownAnthropic
          ? `openclaw.json (${row.scope}, ${row.role}) binds \`${displayKey}\`, which neither the installed ` +
            `model catalog nor Drift Doctor's Anthropic model ontology recognizes — likely a typo or a ` +
            `made-up version.`
          : `openclaw.json (${row.scope}, ${row.role}) binds \`${displayKey}\`, which \`openclaw models list\` ` +
            `does not offer. The binding may fail at run time (or the catalog snapshot is stale).`) +
        staleHedge,
      recommendation:
        "Check the exact key against `openclaw models list` and fix the binding (or add the model under " +
        "models.providers if it is a custom endpoint).",
      evidence: [{ type: "text", text: `${row.scope}: ${row.role} = ${displayKey}` }],
      targetPaths: [],
      fixPrompt:
        `Verify the model binding in openclaw.json (scope: ${row.scope}, role: ${row.role}) against ` +
        `\`openclaw models list\` and correct the key to one the installed OpenClaw actually offers, ` +
        `then verify the agent still responds.`,
    });
  }
  if (suppressed > 0 && emittedCards.length > 0) {
    emittedCards[emittedCards.length - 1].summary +=
      ` (${suppressed} more binding${suppressed === 1 ? "" : "s"} also failed validation — fix these first, then re-scan.)`;
  }
  for (const card of emittedCards) addCard(card);

};

// ── Catalog taxonomy (MECE over the first-party Anthropic domain) ──────────

const buildTaxonomyCard = ({ catalogModels, addCard, sanitize }) => {
  const violations = [];
  const seenKeys = new Set();
  const labelOwners = new Map(); // provider + label → canonical/raw id
  for (const row of Array.isArray(catalogModels) ? catalogModels : []) {
    const key = String(row?.key || "").trim();
    if (!key) continue;
    if (seenKeys.has(key)) {
      violations.push(`duplicate catalog key: ${key}`);
      continue;
    }
    seenKeys.add(key);
    const provider = String(row?.provider || "").trim();
    const keyPrefix = key.split("/")[0];
    if (provider && keyPrefix !== provider) {
      violations.push(`provider mismatch: ${key} declares provider "${provider}"`);
    }
    const canonicalId = canonicalizeAnthropicModelId(key);
    if (provider === "anthropic") {
      // Exhaustiveness over the first-party domain: every anthropic/ row
      // must classify into the ontology. An unclassified row usually means
      // a model newer than the registry — worth surfacing either way.
      // (Proxy providers rebadge and rename models too loosely to hold to
      // the same bar; configured BINDINGS on any provider are still checked
      // by the invalid-coding pass.)
      if (!canonicalId || !getAnthropicRegistryEntry(canonicalId)) {
        violations.push(
          `unclassified anthropic model: ${key} (not in the model ontology — possibly newer than ` +
            `Drift Doctor's registry)`,
        );
      }
    }
    const label = String(row?.label || "").trim();
    if (!label) {
      violations.push(`missing label: ${key}`);
      continue;
    }
    // Mutual exclusivity: within one provider, one label must name one
    // model. Dated snapshots of the same canonical model are aliases, not
    // ambiguity. Space separator is collision-safe: the provider
    // grammar ([a-z0-9._-], a key prefix) cannot contain one.
    const labelKey = `${provider} ${label.toLowerCase()}`;
    const identity = canonicalId || key;
    const owner = labelOwners.get(labelKey);
    if (owner === undefined) {
      labelOwners.set(labelKey, identity);
    } else if (owner !== identity) {
      violations.push(`ambiguous label "${label}" under ${provider}: names two distinct models`);
    }
  }
  violations.push(...validateRegistryOntology().map((line) => `ontology: ${line}`));
  if (!violations.length) return;
  addCard({
    sourceKey: `det:model-drift:taxonomy:${shortHash(violations.slice().sort().join("\n"))}`,
    priority: "P2",
    category: "model drift",
    title: "The model catalog's taxonomy has consistency gaps",
    summary:
      `${violations.length} taxonomy violation${violations.length === 1 ? "" : "s"} found while checking ` +
      `the model catalog (every first-party Anthropic model classified exactly once, labels unambiguous ` +
      `within a provider, provider fields consistent, no duplicate keys).`,
    recommendation:
      "Refresh the model catalog (`openclaw models list --all --json`) and, if violations persist, " +
      "report them upstream; unclassified Anthropic rows may simply be models newer than AlphaClaw.",
    evidence: violations.slice(0, kMaxViolationEvidenceLines).map((line) => ({
      type: "text",
      text: sanitize(line, { maxChars: kDisplayTextMaxChars, singleLine: true }),
    })),
    targetPaths: [],
    fixPrompt:
      "Review the model-catalog taxonomy violations listed on this card. Refresh the catalog, fix any " +
      "custom models.providers entries in openclaw.json that cause them, and report remaining " +
      "inconsistencies upstream. Do not delete catalog entries you did not add.",
  });
};

// ── Context-window checks ──────────────────────────────────────────────────

const buildContextWindowCards = ({ customProviders, catalogModels, addCard, sanitize }) => {
  // 1. FIRST-PARTY catalog rows that disagree with the documented limits for
  //    a registry-classified Anthropic model (a stale CLI shortchanges the
  //    agent's usable context; an inflated one promises tokens the API
  //    rejects). Proxy providers are deliberately out of scope — they re-cap
  //    limits per plan, so a difference there is policy, not drift.
  const mismatches = [];
  for (const row of Array.isArray(catalogModels) ? catalogModels : []) {
    if (!kFirstPartyAnthropicProviders.has(String(row?.provider || ""))) continue;
    const entry = getAnthropicRegistryEntry(row?.key);
    if (!entry) continue;
    if (
      Number.isFinite(entry.contextWindow) &&
      Number.isFinite(row?.contextWindow) &&
      row.contextWindow !== entry.contextWindow
    ) {
      mismatches.push(
        `${row.key}: catalog says ${row.contextWindow} context tokens, ${entry.label} supports ` +
          `${entry.contextWindow}`,
      );
    }
    if (
      Number.isFinite(entry.maxOutputTokens) &&
      Number.isFinite(row?.maxTokens) &&
      row.maxTokens !== entry.maxOutputTokens
    ) {
      mismatches.push(
        `${row.key}: catalog says ${row.maxTokens} max output tokens, ${entry.label} supports ` +
          `${entry.maxOutputTokens}`,
      );
    }
  }
  if (mismatches.length) {
    addCard({
      sourceKey: `det:model-drift:context-catalog:${shortHash(mismatches.slice().sort().join("\n"))}`,
      priority: "P2",
      category: "model drift",
      title: "Catalog model limits disagree with the models' documented limits",
      summary:
        `${mismatches.length} first-party Anthropic catalog entr${mismatches.length === 1 ? "y" : "ies"} ` +
        `advertise${mismatches.length === 1 ? "s" : ""} a max context size or output cap that does not ` +
        `match the documented model limits — sessions may compact far too early or overrun the real ` +
        `limit. (Entitlement-gated limits can also differ legitimately — treat this as a prompt to ` +
        `verify, not proof.)`,
      recommendation:
        "Refresh the model catalog and upgrade OpenClaw if the mismatch persists — the installed CLI is " +
        "advertising stale model limits.",
      evidence: mismatches.slice(0, kMaxViolationEvidenceLines).map((line) => ({
        type: "text",
        text: sanitize(line, { maxChars: kDisplayTextMaxChars, singleLine: true }),
      })),
      targetPaths: [],
      fixPrompt:
        "The installed model catalog advertises context windows or output caps that disagree with the " +
        "models' documented limits (see this card's evidence). Refresh the catalog, and if the values " +
        "persist, upgrade OpenClaw; do not hand-edit generated catalog data.",
    });
  }
  // 2. Custom provider models in openclaw.json without a usable max context
  //    size (missing, non-numeric, or implausible): the gateway falls back
  //    to guessing, so compaction and budget math run on fiction. A
  //    provider-level contextWindow (or defaults.contextWindow) counts as
  //    set for every model under it — inheritance is a valid configuration.
  const providers = customProviders;
  const badEntries = [];
  const isPlausibleWindow = (value) =>
    Number.isFinite(value) &&
    value >= kContextWindowMinTokens &&
    value <= kContextWindowMaxTokens;
  for (const [providerName, providerDef] of Object.entries(providers)) {
    const hasProviderDefault =
      isPlausibleWindow(providerDef?.contextWindow) ||
      isPlausibleWindow(providerDef?.defaults?.contextWindow);
    for (const modelDef of normalizeProviderModelDefs(providerDef)) {
      const id = String(modelDef?.id || modelDef?.name || "").trim() || "(unnamed)";
      const contextWindow = modelDef?.contextWindow;
      if (isPlausibleWindow(contextWindow)) continue;
      if (contextWindow === undefined || contextWindow === null) {
        // A provider-level default excuses a MISSING per-model window —
        // inheritance is valid config. It never excuses an explicit
        // implausible value: the explicit override is what the gateway uses.
        if (hasProviderDefault) continue;
        badEntries.push(`${providerName}/${id}: contextWindow is not set`);
        continue;
      }
      badEntries.push(
        `${providerName}/${id}: contextWindow is ${JSON.stringify(contextWindow)} (implausible)`,
      );
    }
  }
  if (badEntries.length) {
    addCard({
      sourceKey: `det:model-drift:context-custom:${shortHash(badEntries.slice().sort().join("\n"))}`,
      priority: "P2",
      category: "model drift",
      title: "Custom models are missing a valid max context size",
      summary:
        `${badEntries.length} model${badEntries.length === 1 ? "" : "s"} under models.providers in ` +
        `openclaw.json ${badEntries.length === 1 ? "has" : "have"} no usable contextWindow — the gateway ` +
        `cannot budget context or trigger compaction correctly for ${badEntries.length === 1 ? "it" : "them"}.`,
      recommendation:
        "Set contextWindow (tokens) on each custom model entry — or one provider-level contextWindow — " +
        "to the model's documented max context size.",
      evidence: badEntries.slice(0, kMaxViolationEvidenceLines).map((line) => ({
        type: "text",
        text: sanitize(line, { maxChars: kDisplayTextMaxChars, singleLine: true }),
      })),
      targetPaths: [],
      fixPrompt:
        "In openclaw.json, set a correct contextWindow (max context size in tokens, from the provider's " +
        "documentation) on every models.providers entry listed on this card, then verify the models still " +
        "load with `openclaw models list`.",
    });
  }
};

// ── Skills referencing old models ──────────────────────────────────────────

const scanSkillFilesForStaleModels = (workspaceRoot, { maxVisitedDirents }) => {
  const skillsRoot = path.join(workspaceRoot, "skills");
  const findings = [];
  // Containment: skills/ itself could be a symlink out of the agent-writable
  // workspace — refuse to walk anything that resolves outside it (sub-entry
  // symlinks are already skipped: Dirent.isDirectory/isFile are false).
  try {
    const realWorkspace = fs.realpathSync(workspaceRoot);
    const realSkillsRoot = fs.realpathSync(skillsRoot);
    if (
      realSkillsRoot !== realWorkspace &&
      !realSkillsRoot.startsWith(realWorkspace + path.sep)
    ) {
      return { findings, truncated: false };
    }
  } catch {
    // no skills dir (or unresolvable root): nothing to scan
    return { findings, truncated: false };
  }
  let visitedDirents = 0;
  let candidates = 0;
  let totalBytesRead = 0;
  let truncated = false;
  // Lazy: most scans visit zero SKILL.md files; don't pay 256KB per tick.
  let readBuffer = null;
  // Files repeat the same handful of ids — memoize canonicalization per raw
  // match so an id-dense 8MB worst case stays ~O(bytes), not O(matches).
  const entryByMatch = new Map();
  const walk = (dir, depth) => {
    if (depth > kSkillsScanMaxDepth || truncated) return;
    // Streaming read: readdirSync would materialize the ENTIRE listing
    // before any cap applies — one huge agent-written directory must not
    // stall the event loop past the dirent budget.
    let dirHandle;
    try {
      dirHandle = fs.opendirSync(dir);
    } catch {
      return;
    }
    try {
      let entry;
      while ((entry = dirHandle.readSync()) !== null) {
        if (
          visitedDirents >= maxVisitedDirents ||
          candidates >= kSkillsScanMaxCandidates ||
          totalBytesRead >= kSkillsScanMaxTotalReadBytes
        ) {
          truncated = true;
          return;
        }
        visitedDirents += 1;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name === "SKILL.md") {
          candidates += 1;
          if (!readBuffer) readBuffer = Buffer.allocUnsafe(kSkillReadMaxBytes);
          let content = "";
          try {
            const fd = fs.openSync(fullPath, "r");
            try {
              const bytesRead = fs.readSync(fd, readBuffer, 0, readBuffer.length, 0);
              totalBytesRead += bytesRead;
              content = readBuffer.toString("utf8", 0, bytesRead);
            } finally {
              fs.closeSync(fd);
            }
          } catch {
            continue;
          }
          const stale = new Map(); // canonical id → registry entry
          for (const match of content.matchAll(kEmbeddedModelIdPattern)) {
            // Boundary guards against the ORIGINAL content: canonicalizing the
            // extracted substring alone would erase the context its lookbehind
            // and suffix guards need ("notclaude-opus-4-5" and
            // "claude-opus-4-6-migration" must not read as model references).
            const before = match.index === 0 ? "" : content[match.index - 1];
            const after = content[match.index + match[0].length] || "";
            if (/[a-z0-9]/i.test(before) || after === "-") continue;
            let entryForId;
            if (entryByMatch.has(match[0])) {
              entryForId = entryByMatch.get(match[0]);
            } else {
              entryForId = getAnthropicRegistryEntry(match[0]);
              entryByMatch.set(match[0], entryForId);
            }
            if (!entryForId) continue;
            if (entryForId.status === "deprecated" || entryForId.status === "legacy") {
              stale.set(entryForId.id, entryForId);
            }
          }
          if (stale.size) {
            findings.push({
              location: path.relative(skillsRoot, dir).split(path.sep).join("/"),
              stale: Array.from(stale.values()),
            });
          }
        }
      }
    } finally {
      try {
        dirHandle.closeSync();
      } catch {
        // already closed
      }
    }
  };
  walk(skillsRoot, 1);
  if (truncated) {
    // A truncated scan with zero findings would otherwise read as clean.
    try {
      console.warn(
        "[doctor] model-drift skills scan truncated at its safety caps — coverage is partial",
      );
    } catch {
      // best-effort
    }
  }
  return { findings, truncated };
};

const buildSkillModelCards = ({
  workspaceRoot,
  catalogIndex,
  addCard,
  sanitize,
  maxVisitedDirents,
}) => {
  const { findings, truncated } = scanSkillFilesForStaleModels(workspaceRoot, {
    maxVisitedDirents,
  });
  // Filter BEFORE capping: legacy references only surface once their
  // successor is installed; deprecated references always do. A finding with
  // nothing actionable must not consume one of the capped card slots.
  const emittable = findings
    .map((finding) => ({
      ...finding,
      flagged: finding.stale.filter(
        (entry) =>
          entry.status === "deprecated" ||
          findNewerSameTierEntry(entry, catalogIndex.availableCanonicalIds),
      ),
    }))
    .filter((finding) => finding.flagged.length > 0);
  const emittedCount = Math.min(emittable.length, kMaxSkillCards);
  const overflow = emittable.length - emittedCount;
  emittable.slice(0, kMaxSkillCards).forEach((finding, index) => {
    const replacements = finding.flagged.map((entry) => {
      const successor =
        findNewerSameTierEntry(entry, catalogIndex.availableCanonicalIds) ||
        findNewerSameTierEntry(entry);
      return { from: entry, to: successor };
    });
    const locationIsSafe =
      kSafeLocationPattern.test(finding.location) || finding.location === "";
    const displayLocation = sanitize(`skills/${finding.location}`, {
      maxChars: kDisplayTextMaxChars,
      singleLine: true,
    });
    const skillFilePath = finding.location
      ? `skills/${finding.location}/SKILL.md`
      : "skills/SKILL.md";
    const isLastEmitted = index === emittedCount - 1;
    // The flagged-id set rides the sourceKey: dismissing a card about model
    // A in this skill must not suppress a future card when model B starts
    // drifting in the same skill.
    const flaggedIdsHash = shortHash(
      finding.flagged.map((entry) => entry.id).sort().join(","),
    );
    addCard({
      sourceKey: `det:model-drift:skill:${
        locationIsSafe && finding.location.length <= kSourceKeyLocationMaxChars
          ? finding.location
          : shortHash(finding.location)
      }:${flaggedIdsHash}`,
      priority: "P2",
      category: "model drift",
      title: `Skill ${displayLocation} references outdated models`,
      summary:
        `${displayLocation}/SKILL.md names ${finding.flagged
          .map((entry) => entry.label)
          .join(", ")} — guidance written for old models steers the agent toward them.` +
        (isLastEmitted && overflow > 0
          ? ` (${overflow} more skill${overflow === 1 ? "" : "s"} also reference outdated models — re-scan after fixing these.)`
          : "") +
        (isLastEmitted && truncated
          ? " (Skills scan hit its safety cap; the real count may be higher.)"
          : ""),
      recommendation:
        `Update the references — skipping any that deliberately document the old model (compatibility ` +
        `notes, changelogs): ${replacements
          .map(({ from, to }) => `${from.id} → ${to ? to.id : "a current-generation model"}`)
          .join(", ")}.`,
      evidence: finding.flagged.map((entry) => ({
        type: "text",
        text: `${displayLocation}/SKILL.md references ${entry.id} (${entry.status})`,
      })),
      targetPaths: locationIsSafe ? [{ path: skillFilePath }] : [],
      fixPrompt: locationIsSafe
        ? `In ${skillFilePath}, replace the outdated model references (${replacements
            .map(({ from, to }) => `${from.id} with ${to ? to.id : "a current-generation Anthropic model"}`)
            .join("; ")}) and reread the surrounding guidance so it still makes sense for the newer ` +
          `model. Leave references that deliberately document the old model (compatibility notes, ` +
          `changelogs). Do not change what the skill does.`
        : `A workspace skill references outdated Anthropic models (see this card's evidence). Update the ` +
          `references to current-generation models and reread the surrounding guidance so it still makes sense.`,
    });
  });
};

// ── Entry point ────────────────────────────────────────────────────────────

const buildModelDriftCards = ({
  config = null,
  catalogModels = [],
  // "openclaw" (fresh CLI listing) | "cache" (last CLI listing) |
  // "bootstrap" (bundled snapshot) — copy hedges on the weakest source.
  catalogSource = "",
  workspaceRoot = "",
  sanitize = (text) => String(text ?? ""),
  // Test seam, mirroring deterministic-checks.
  skillsScanMaxVisitedDirents = kSkillsScanMaxVisitedDirents,
} = {}) => {
  const cards = [];
  const addCard = ({ sourceKey, ...card }) => {
    cards.push({
      ...card,
      status: "open",
      source: kDoctorCardSource.deterministic,
      sourceKey,
    });
  };
  // Every stage is fail-soft — a malformed config or catalog row must never
  // take down the whole scan — but never SILENTLY soft: a broken check
  // reported as "no drift" would discredit every clean scan after it.
  const warnCheckFailed = (checkName, error) => {
    try {
      console.warn(
        `[doctor] model-drift ${checkName} check failed: ${error?.message || error}`,
      );
    } catch {
      // even the warn is best-effort
    }
  };
  const safeCompute = (checkName, fn, fallback) => {
    try {
      return fn();
    } catch (error) {
      warnCheckFailed(checkName, error);
      return fallback;
    }
  };
  const safeRun = (checkName, fn) => {
    safeCompute(checkName, fn, undefined);
  };
  // Shared derivations, computed once per scan (the binding and validity
  // checks must never disagree about what the config binds).
  const catalogIndex = safeCompute(
    "catalog-index",
    () => indexCatalog(catalogModels),
    indexCatalog([]),
  );
  const configuredRows = safeCompute(
    "config-bindings",
    () => collectConfiguredModels(config),
    [],
  );
  const customProviders = safeCompute(
    "custom-providers",
    () =>
      config?.models?.providers && typeof config.models.providers === "object"
        ? config.models.providers
        : {},
    {},
  );
  safeRun("bindings", () =>
    buildBindingDriftCards({ configuredRows, catalogIndex, addCard, sanitize }),
  );
  safeRun("invalid-bindings", () =>
    buildInvalidBindingCards({
      configuredRows,
      customProviders,
      catalogIndex,
      catalogSource,
      addCard,
      sanitize,
    }),
  );
  safeRun("taxonomy", () => buildTaxonomyCard({ catalogModels, addCard, sanitize }));
  safeRun("context-windows", () =>
    buildContextWindowCards({ customProviders, catalogModels, addCard, sanitize }),
  );
  if (workspaceRoot) {
    safeRun("skills", () =>
      buildSkillModelCards({
        workspaceRoot,
        catalogIndex,
        addCard,
        sanitize,
        maxVisitedDirents: skillsScanMaxVisitedDirents,
      }),
    );
  }
  return cards;
};

module.exports = {
  buildModelDriftCards,
  collectConfiguredModels,
};
