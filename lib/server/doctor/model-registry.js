// Authoritative Anthropic model ontology for Drift Doctor's model-drift
// checks. The registry is the taxonomy the checks validate against: every
// entry belongs to exactly ONE tier (mutually exclusive) and the tier lists
// together must classify every FIRST-PARTY anthropic/claude-* row the
// installed catalog can emit (collectively exhaustive over that domain) — an
// anthropic catalog row this registry cannot classify is itself surfaced as
// an exhaustiveness gap, never silently skipped. Facts (context windows,
// output caps, lifecycle status) come from Anthropic's published model
// documentation, snapshotted 2026-08; unverified values stay null so
// downstream checks skip them instead of asserting a guess.
//
// Ordering IS data: within each tier, entries are declared NEWEST FIRST and
// recency comparisons use that declaration order (never numeric version
// math — "4.10" vs "4.8" breaks float comparison). `generation` is a display
// string only. Statuses:
//   current    — still a recommended model in its tier (a tier can carry
//                more than one during a transition); no drift card by
//                itself. The FIRST entry of every tier must be current.
//   legacy     — still served, but a newer same-tier model exists; nudge
//                (P2) only when the successor is actually available in the
//                installed catalog.
//   deprecated — should no longer be used (quality/lifecycle); always a P1,
//                and never offered as a successor.
const kAnthropicModelTiers = ["fable", "mythos", "opus", "sonnet", "haiku"];

const kAnthropicModelRegistry = [
  // Frontier tier (Claude 5 family).
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    tier: "fable",
    generation: "5",
    status: "current",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
  },
  {
    id: "claude-mythos-5",
    label: "Claude Mythos 5",
    tier: "mythos",
    generation: "5",
    status: "current",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
  },
  // Opus tier (newest first — declaration order is the recency order).
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    tier: "opus",
    generation: "5",
    status: "current",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    tier: "opus",
    generation: "4.8",
    status: "legacy",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    tier: "opus",
    generation: "4.7",
    status: "legacy",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    tier: "opus",
    generation: "4.6",
    status: "deprecated",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
  },
  {
    id: "claude-opus-4-5",
    label: "Claude Opus 4.5",
    tier: "opus",
    generation: "4.5",
    status: "deprecated",
    contextWindow: 200000,
    maxOutputTokens: null,
  },
  {
    id: "claude-opus-4-1",
    label: "Claude Opus 4.1",
    tier: "opus",
    generation: "4.1",
    status: "deprecated",
    contextWindow: 200000,
    maxOutputTokens: null,
  },
  {
    id: "claude-opus-4",
    label: "Claude Opus 4",
    tier: "opus",
    generation: "4",
    status: "deprecated",
    contextWindow: 200000,
    maxOutputTokens: null,
  },
  // Sonnet tier.
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    tier: "sonnet",
    generation: "5",
    status: "current",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    tier: "sonnet",
    generation: "4.6",
    status: "legacy",
    contextWindow: 1000000,
    maxOutputTokens: 128000,
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    tier: "sonnet",
    generation: "4.5",
    status: "deprecated",
    contextWindow: 200000,
    maxOutputTokens: null,
  },
  {
    id: "claude-sonnet-4",
    label: "Claude Sonnet 4",
    tier: "sonnet",
    generation: "4",
    status: "deprecated",
    contextWindow: 200000,
    maxOutputTokens: null,
  },
  {
    id: "claude-sonnet-3-7",
    label: "Claude Sonnet 3.7",
    tier: "sonnet",
    generation: "3.7",
    status: "deprecated",
    contextWindow: 200000,
    maxOutputTokens: null,
  },
  // Haiku tier. claude-haiku-4-6 is referenced by this repo's own pricing
  // and fallback tables but is absent from the snapshotted Anthropic docs —
  // its limits stay null (unverified) so context checks skip it; haiku-4-5
  // stays current alongside it (transition period, both recommended).
  {
    id: "claude-haiku-4-6",
    label: "Claude Haiku 4.6",
    tier: "haiku",
    generation: "4.6",
    status: "current",
    contextWindow: null,
    maxOutputTokens: null,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    tier: "haiku",
    generation: "4.5",
    status: "current",
    contextWindow: 200000,
    maxOutputTokens: null,
  },
  {
    id: "claude-haiku-3-5",
    label: "Claude Haiku 3.5",
    tier: "haiku",
    generation: "3.5",
    status: "deprecated",
    contextWindow: 200000,
    maxOutputTokens: null,
  },
  {
    id: "claude-haiku-3",
    label: "Claude Haiku 3",
    tier: "haiku",
    generation: "3",
    status: "deprecated",
    contextWindow: 200000,
    maxOutputTokens: null,
  },
];

const kRegistryById = new Map(
  kAnthropicModelRegistry.map((entry) => [entry.id, entry]),
);
// Per-tier recency rank from declaration order: rank 0 = newest in tier.
const kTierRankById = new Map();
{
  const perTierCounts = new Map();
  for (const entry of kAnthropicModelRegistry) {
    const rank = perTierCounts.get(entry.tier) || 0;
    kTierRankById.set(entry.id, rank);
    perTierCounts.set(entry.tier, rank + 1);
  }
}

// Canonicalize any string that embeds an Anthropic model id down to a
// registry id: provider prefixes (anthropic/, claude-cli/, us.anthropic.…),
// dot version notation (claude-opus-4.6), dated snapshot suffixes
// (-20251001), platform decorations (-v1:0, @20251101, -latest), and the
// pre-4 id order (claude-3-7-sonnet) all normalize to the same id. Guarded
// both ways against lookalikes: "claude-" must start at a token boundary
// (vendor/notclaude-opus-4-5 is NOT a Claude model), and a match followed by
// an unconsumed dash-suffix (claude-opus-4-6-migration) is a longer token
// that merely embeds a model id — not a model reference. Returns null when
// the string carries no Anthropic model id.
const kModernIdPattern =
  /(?<![a-z0-9])claude-(?:opus|sonnet|haiku|fable|mythos)(?:[.-]\d+)*(?:-(?:latest|v\d+(?::\d+)?|20\d{6}))*/;
const kLegacyIdPattern =
  /(?<![a-z0-9])claude-(\d(?:[.-]\d)?)-(opus|sonnet|haiku)(?:-(?:latest|20\d{6}))*/;

const canonicalizeAnthropicModelId = (value) => {
  const normalized = String(value || "").toLowerCase();
  const modernMatch = kModernIdPattern.exec(normalized);
  const legacyMatch = kLegacyIdPattern.exec(normalized);
  // Prefer whichever pattern matched earliest — a string containing both
  // forms should resolve its first id.
  const match =
    legacyMatch && (!modernMatch || legacyMatch.index < modernMatch.index)
      ? legacyMatch
      : modernMatch;
  if (!match) return null;
  // Unconsumed dash-suffix after the match: a longer hyphenated token
  // (claude-opus-4-6-migration-notes), not a model id.
  if (normalized[match.index + match[0].length] === "-") return null;
  const candidate =
    match === legacyMatch ? `claude-${match[2]}-${match[1]}` : match[0];
  const id = candidate
    .replace(/(\d)\.(\d)/g, "$1-$2") // 4.6 → 4-6
    .replace(/-v\d+(?::\d+)?$/, "") // Bedrock -v1:0
    .replace(/@20\d{6}$/, "") // Vertex @-dated snapshot
    .replace(/-20\d{6}$/, "") // dated snapshot suffix
    .replace(/-latest$/, "");
  // A bare tier word with no version digits (plain "claude-opus") is not a
  // model id we can classify.
  return kRegistryById.has(id) || /\d/.test(id) ? id : null;
};

const getAnthropicRegistryEntry = (value) => {
  const id = canonicalizeAnthropicModelId(value);
  return id ? kRegistryById.get(id) || null : null;
};

// Newest same-tier entry strictly newer than `entry` (by declaration order),
// never deprecated, optionally restricted to ids present in `availableIds`
// (a Set of canonical ids from the installed catalog). Returns null when
// nothing newer qualifies.
const findNewerSameTierEntry = (entry, availableIds = null) => {
  if (!entry) return null;
  const entryRank = kTierRankById.get(entry.id);
  if (entryRank === undefined) return null;
  for (const candidate of kAnthropicModelRegistry) {
    if (candidate.tier !== entry.tier) continue;
    if (kTierRankById.get(candidate.id) >= entryRank) continue;
    if (candidate.status === "deprecated") continue;
    if (availableIds && !availableIds.has(candidate.id)) continue;
    // First qualifying hit is the newest: declaration order is recency order.
    return candidate;
  }
  return null;
};

// Self-check of the ontology's own invariants. Runs inside the taxonomy
// check as a belt — a violation here is a bug in THIS file. The overrides
// exist ONLY so tests can prove each violation branch fires; production
// callers pass nothing.
const validateRegistryOntology = ({
  registry = kAnthropicModelRegistry,
  tiers = kAnthropicModelTiers,
} = {}) => {
  const violations = [];
  const seenIds = new Set();
  const seenTierGenerations = new Set();
  const tierHeads = new Map(); // tier → first-declared entry
  for (const entry of registry) {
    if (seenIds.has(entry.id)) {
      violations.push(`duplicate registry id: ${entry.id}`);
    }
    seenIds.add(entry.id);
    if (!tiers.includes(entry.tier)) {
      violations.push(`unknown tier "${entry.tier}" on ${entry.id}`);
    }
    const tierGeneration = `${entry.tier}:${entry.generation}`;
    if (seenTierGenerations.has(tierGeneration)) {
      violations.push(`overlapping tier/generation: ${tierGeneration}`);
    }
    seenTierGenerations.add(tierGeneration);
    if (!tierHeads.has(entry.tier)) tierHeads.set(entry.tier, entry);
  }
  for (const tier of tiers) {
    const head = tierHeads.get(tier);
    if (!head) {
      violations.push(`tier "${tier}" has no models`);
    } else if (head.status !== "current") {
      // The newest entry per tier drives successor advice — it must be a
      // model we are willing to recommend.
      violations.push(`tier "${tier}" newest entry ${head.id} is not current`);
    }
  }
  return violations;
};

// The registry data stays module-private: consumers go through the accessor
// functions so the ontology's invariants (canonical ids, declaration-order
// recency) cannot be bypassed by reaching into the raw table.
module.exports = {
  canonicalizeAnthropicModelId,
  getAnthropicRegistryEntry,
  findNewerSameTierEntry,
  validateRegistryOntology,
};
