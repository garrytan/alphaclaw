const fs = require("fs");
const path = require("path");

const kTokensPerMillion = 1_000_000;
const kLongContextThresholdTokens = 200_000;
const kNodeModulesPricingCacheTtlMs = 60_000;

const kClaudeOpus47Pricing = {
  input: 5.0,
  output: 25.0,
  cacheRead: 0.5,
  cacheWrite: 6.25,
};

const kGlobalModelPricing = {
  "claude-opus-4-8": kClaudeOpus47Pricing,
  "claude-opus-4.8": kClaudeOpus47Pricing,
  "claude-opus-4-7": kClaudeOpus47Pricing,
  "claude-opus-4.7": kClaudeOpus47Pricing,
  "claude-opus-4-6": {
    input: (tokens) => (tokens > kLongContextThresholdTokens ? 10.0 : 5.0),
    output: (tokens) => (tokens > kLongContextThresholdTokens ? 37.5 : 25.0),
  },
  "claude-sonnet-4-5": {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-sonnet-4.5": {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-sonnet-4-6": {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-sonnet-4.6": {
    input: 3.0,
    output: 15.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-haiku-4-6": { input: 0.8, output: 4.0 },
  "gpt-5": { input: 1.25, output: 10.0 },
  "gpt-5.4": { input: 2.5, output: 10.0 },
  "gpt-5.6-sol": {
    input: 5.0,
    output: 30.0,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  },
  "gpt-5.6-terra": {
    input: 2.5,
    output: 15.0,
    cacheRead: 0.25,
    cacheWrite: 3.125,
  },
  "gpt-5.6-luna": {
    input: 1.0,
    output: 6.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
  },
  "gpt-5.1-codex": { input: 2.5, output: 10.0 },
  "gpt-5.3-codex": { input: 2.5, output: 10.0 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
  "gemini-3-flash-preview": { input: 0.5, output: 3.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  // Upstream PR #86 additions. The pinned openclaw 2026.7.1-2 scraper carries
  // none of these ids (verified live): without them gpt-5.5/gpt-5.4-mini
  // misprice as gpt-5 and the rest bill at zero.
  "gpt-5.5": { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 5.0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  "kimi-k2.6:cloud": { input: 0.8, output: 3.0, cacheRead: 0.1, cacheWrite: 0.8 },
  "deepseek-v4-flash:cloud": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0.14 },
  "glm-5.1:cloud": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.4 },
  "grok-4.3": { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
  "qwen3-coder-next": { input: 0.11, output: 0.8, cacheRead: 0.0, cacheWrite: 0.11 },
  "minimax-m3:cloud": { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.6 },
};

// Most-specific-first fallback keys, hoisted: deriveCostBreakdown runs per
// usage row and must not re-sort on every miss. Longest-first means "gpt-5"
// can never shadow "gpt-5.5" (upstream PR #86); equal-length ties keep
// insertion order (stable sort).
const kFallbackPricingKeysBySpecificity = Object.keys(kGlobalModelPricing).sort(
  (a, b) => b.length - a.length,
);

const toInt = (value, fallbackValue = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
};

const toCleanString = (value = "") =>
  String(value || "")
    .trim()
    .toLowerCase();

const toFiniteRate = (value, fallbackValue = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
};

const parseCostObjectText = (costObjectText = "") => {
  const inputMatch = costObjectText.match(/input:\s*([0-9.]+)/);
  const outputMatch = costObjectText.match(/output:\s*([0-9.]+)/);
  const cacheReadMatch = costObjectText.match(/cacheRead:\s*([0-9.]+)/);
  const cacheWriteMatch = costObjectText.match(/cacheWrite:\s*([0-9.]+)/);
  if (!inputMatch || !outputMatch) return null;
  return {
    input: toFiniteRate(inputMatch[1]),
    output: toFiniteRate(outputMatch[1]),
    cacheRead: toFiniteRate(cacheReadMatch?.[1], 0),
    cacheWrite: toFiniteRate(cacheWriteMatch?.[1], 0),
  };
};

const setPricingCandidates = (
  pricingByModelKey,
  modelKey = "",
  pricing = null,
) => {
  const normalizedModelKey = toCleanString(modelKey);
  if (!normalizedModelKey || !pricing) return;
  pricingByModelKey.set(normalizedModelKey, pricing);
  const claudeDashVariant = normalizedModelKey.replace(
    /(claude-(?:opus|sonnet)-\d+)\.(\d+)/g,
    "$1-$2",
  );
  const claudeDotVariant = normalizedModelKey.replace(
    /(claude-(?:opus|sonnet)-\d+)-(\d+)/g,
    "$1.$2",
  );
  if (claudeDashVariant !== normalizedModelKey) {
    pricingByModelKey.set(claudeDashVariant, pricing);
  }
  if (claudeDotVariant !== normalizedModelKey) {
    pricingByModelKey.set(claudeDotVariant, pricing);
  }
  const modelId = normalizedModelKey.split("/").filter(Boolean).pop();
  if (modelId && !pricingByModelKey.has(modelId)) {
    pricingByModelKey.set(modelId, pricing);
  }
  const modelIdClaudeDashVariant = String(modelId || "").replace(
    /(claude-(?:opus|sonnet)-\d+)\.(\d+)/g,
    "$1-$2",
  );
  const modelIdClaudeDotVariant = String(modelId || "").replace(
    /(claude-(?:opus|sonnet)-\d+)-(\d+)/g,
    "$1.$2",
  );
  if (modelIdClaudeDashVariant && !pricingByModelKey.has(modelIdClaudeDashVariant)) {
    pricingByModelKey.set(modelIdClaudeDashVariant, pricing);
  }
  if (modelIdClaudeDotVariant && !pricingByModelKey.has(modelIdClaudeDotVariant)) {
    pricingByModelKey.set(modelIdClaudeDotVariant, pricing);
  }
};

const extractPricingFromDistFile = (
  filePath = "",
  pricingByModelKey = new Map(),
) => {
  let sourceText = "";
  try {
    sourceText = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  const directEntryPattern =
    /id:\s*"([^"]+)"[\s\S]{0,260}?cost:\s*(\{[\s\S]{0,180}?\})/g;
  let directEntryMatch = directEntryPattern.exec(sourceText);
  while (directEntryMatch) {
    const pricing = parseCostObjectText(directEntryMatch[2] || "");
    if (pricing) {
      setPricingCandidates(pricingByModelKey, directEntryMatch[1], pricing);
    }
    directEntryMatch = directEntryPattern.exec(sourceText);
  }

  const defaultModelPattern =
    /const\s+([A-Z0-9_]+)_DEFAULT_MODEL_(?:ID|REF)\s*=\s*(?:`([^`]+)`|"([^"]+)"|'([^']+)')/g;
  let defaultModelMatch = defaultModelPattern.exec(sourceText);
  while (defaultModelMatch) {
    const constantPrefix = defaultModelMatch[1];
    const modelKey =
      defaultModelMatch[2] || defaultModelMatch[3] || defaultModelMatch[4] || "";
    const defaultCostPattern = new RegExp(
      `const\\s+${constantPrefix}_DEFAULT_COST\\s*=\\s*(\\{[\\s\\S]{0,180}?\\})`,
      "m",
    );
    const defaultCostMatch = sourceText.match(defaultCostPattern);
    const pricing = parseCostObjectText(defaultCostMatch?.[1] || "");
    if (pricing) {
      setPricingCandidates(pricingByModelKey, modelKey, pricing);
    }
    defaultModelMatch = defaultModelPattern.exec(sourceText);
  }
};

// Since 2026.9.x OpenClaw ships model prices as JSON in each bundled
// provider plugin's manifest, dist/extensions/<plugin>/openclaw.plugin.json:
//   modelCatalog.providers.<provider>.models[] = { id, cost: { input, output,
//   cacheRead, cacheWrite, tieredPricing? } }  (USD per million tokens)
// 2026.10.2 prices 86 models this way (anthropic/claude-opus-5-5 is
// { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }). tieredPricing is
// not applied: upstream selects a tier per model call from that call's prompt
// tokens (usage-cost: input + cacheRead + cacheWrite), and most callers here
// price aggregated rows, so the base rates are used.
const toManifestPricing = (cost) => {
  if (!cost || typeof cost !== "object") return null;
  if (!Number.isFinite(cost.input) || !Number.isFinite(cost.output)) return null;
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: toFiniteRate(cost.cacheRead, 0),
    cacheWrite: toFiniteRate(cost.cacheWrite, 0),
  };
};

const claudeKeyVariants = (key) => [
  ...new Set([
    key,
    key.replace(/(claude-(?:opus|sonnet|haiku)-\d+)\.(\d+)/g, "$1-$2"),
    key.replace(/(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)/g, "$1.$2"),
  ]),
];

// Provider-qualified keys always register. A bare model id registers only
// when every manifest that prices it agrees: aggregators re-list first-party
// ids at their own rates (github-copilot/gpt-5.6-sol has cacheWrite 0,
// opencode-go/gpt-5.6-luna is cheaper than openai/gpt-5.6-luna), so a
// disagreement leaves the bare id to the static fallback map.
const extractPricingFromPluginManifests = (distDirPath = "", pricingByModelKey = new Map()) => {
  const extensionsDir = path.join(distDirPath, "extensions");
  let pluginDirs = [];
  try {
    pluginDirs = fs
      .readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return;
  }
  const bareCandidates = new Map();
  for (const pluginDir of pluginDirs) {
    let manifest = null;
    try {
      manifest = JSON.parse(
        fs.readFileSync(path.join(extensionsDir, pluginDir, "openclaw.plugin.json"), "utf8"),
      );
    } catch {
      continue;
    }
    const providers = manifest?.modelCatalog?.providers;
    if (!providers || typeof providers !== "object") continue;
    for (const [providerId, providerDef] of Object.entries(providers)) {
      const models = Array.isArray(providerDef?.models) ? providerDef.models : [];
      for (const modelDef of models) {
        const modelId = toCleanString(modelDef?.id);
        const pricing = toManifestPricing(modelDef?.cost);
        if (!modelId || !pricing) continue;
        const provider = toCleanString(providerId);
        const lastSegment = modelId.split("/").filter(Boolean).pop();
        for (const key of new Set([`${provider}/${modelId}`, `${provider}/${lastSegment}`])) {
          for (const variant of claudeKeyVariants(key)) pricingByModelKey.set(variant, pricing);
        }
        for (const variant of claudeKeyVariants(lastSegment)) {
          const existing = bareCandidates.get(variant);
          if (existing === undefined) {
            bareCandidates.set(variant, pricing);
          } else if (existing && JSON.stringify(existing) !== JSON.stringify(pricing)) {
            bareCandidates.set(variant, null);
          }
        }
      }
    }
  }
  for (const [key, pricing] of bareCandidates) {
    if (pricing && !pricingByModelKey.has(key)) pricingByModelKey.set(key, pricing);
  }
};

let cachedNodeModulesPricingMap = null;
let cachedNodeModulesPricingLoadedAt = 0;
// Legacy dist-chunk scrape. Chunks are `.mjs` since 2026.9.3; on 2026.9.8 and
// 2026.10.2 these chunks carry no `id: … cost: {…}` literals (zero hits), so
// the plugin manifests above are the live source.
const kOpenclawPricingDistFilePatterns = [
  /^model-selection(?:-.+)?\.m?js$/,
  /^config(?:-.+)?\.m?js$/,
  /^onboard-custom(?:-.+)?\.m?js$/,
  /^configure(?:-.+)?\.m?js$/,
];

const loadOpenclawNodeModulesPricingMap = () => {
  const nowMs = Date.now();
  if (
    cachedNodeModulesPricingMap &&
    nowMs - cachedNodeModulesPricingLoadedAt < kNodeModulesPricingCacheTtlMs
  ) {
    return cachedNodeModulesPricingMap;
  }

  let distDirPath = "";
  try {
    const openclawEntryPath = require.resolve("openclaw");
    distDirPath = path.dirname(openclawEntryPath);
  } catch {
    cachedNodeModulesPricingMap = new Map();
    cachedNodeModulesPricingLoadedAt = nowMs;
    return cachedNodeModulesPricingMap;
  }

  const pricingByModelKey = new Map();
  let distFileNames = [];
  try {
    distFileNames = fs
      .readdirSync(distDirPath)
      .filter((fileName) => /\.m?js$/.test(fileName));
  } catch {
    cachedNodeModulesPricingMap = new Map();
    cachedNodeModulesPricingLoadedAt = nowMs;
    return cachedNodeModulesPricingMap;
  }

  distFileNames.forEach((fileName) => {
    const shouldScanFile = kOpenclawPricingDistFilePatterns.some((pattern) =>
      pattern.test(fileName),
    );
    if (!shouldScanFile) return;
    extractPricingFromDistFile(
      path.join(distDirPath, fileName),
      pricingByModelKey,
    );
  });
  extractPricingFromPluginManifests(distDirPath, pricingByModelKey);

  cachedNodeModulesPricingMap = pricingByModelKey;
  cachedNodeModulesPricingLoadedAt = nowMs;
  return pricingByModelKey;
};

const resolvePricingFromOpenclawNodeModules = ({
  provider = "",
  model = "",
} = {}) => {
  const normalizedProvider = toCleanString(provider);
  const normalizedModel = toCleanString(model);
  if (!normalizedModel) return null;
  const pricingByModelKey = loadOpenclawNodeModulesPricingMap();
  const modelId =
    normalizedModel.split("/").filter(Boolean).pop() || normalizedModel;
  const lookupCandidates = [];
  if (normalizedProvider && modelId) {
    lookupCandidates.push(`${normalizedProvider}/${modelId}`);
  }
  lookupCandidates.push(normalizedModel);
  if (modelId) lookupCandidates.push(modelId);

  for (const candidate of lookupCandidates) {
    const pricing = pricingByModelKey.get(candidate);
    if (pricing) return pricing;
  }
  return null;
};

// A fallback key only counts where it is not flanked by alphanumerics, so
// dated/variant ids still resolve their family (gpt-5.1-codex-20260101 →
// gpt-5.1-codex, us.anthropic.claude-opus-4-8-v1:0 → claude-opus-4-8) while
// gpt-5x / gpt-55 never false-positive onto gpt-5.
const isPricingKeyBoundaryChar = (character) =>
  !/[a-z0-9]/.test(String(character || ""));
const matchesPricingKeyAtBoundary = (normalized, key) => {
  let fromIndex = 0;
  while (fromIndex <= normalized.length - key.length) {
    const at = normalized.indexOf(key, fromIndex);
    if (at === -1) return false;
    const before = at === 0 ? "" : normalized[at - 1];
    const after = normalized[at + key.length] || "";
    if (isPricingKeyBoundaryChar(before) && isPricingKeyBoundaryChar(after)) {
      return true;
    }
    fromIndex = at + 1;
  }
  return false;
};

// Accepted model-id grammar: id := [segment "/"]* component, where the final
// component may carry provider/date/variant decoration. Resolution order:
// exact full id → exact trailing component → most-specific boundary match.
const resolvePricingFromFallbackMap = (model = "") => {
  const normalized = String(model || "").toLowerCase();
  if (!normalized) return null;
  const exact = kGlobalModelPricing[normalized];
  if (exact) return exact;
  const modelId = normalized.split("/").filter(Boolean).pop() || normalized;
  if (kGlobalModelPricing[modelId]) return kGlobalModelPricing[modelId];
  const matchKey = kFallbackPricingKeysBySpecificity.find((key) =>
    matchesPricingKeyAtBoundary(normalized, key),
  );
  return matchKey ? kGlobalModelPricing[matchKey] : null;
};

const kCacheReadInputRatioFallback = 0.1;

const resolvePerMillionRate = (rate, tokens) => {
  if (typeof rate === "function") {
    return Number(rate(toInt(tokens)));
  }
  return Number(rate || 0);
};

const deriveCostBreakdown = ({
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  provider = "",
  model = "",
} = {}) => {
  const pricing =
    resolvePricingFromOpenclawNodeModules({ provider, model }) ||
    resolvePricingFromFallbackMap(model);
  if (!pricing) {
    return {
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      totalCost: 0,
      pricingFound: false,
    };
  }
  const inputRate = resolvePerMillionRate(pricing.input, inputTokens);
  const outputRate = resolvePerMillionRate(pricing.output, outputTokens);
  const inputCost = (inputTokens / kTokensPerMillion) * inputRate;
  const outputCost = (outputTokens / kTokensPerMillion) * outputRate;
  // Fix wave F083: about half the static fallback entries omit cacheRead;
  // the old code billed those reads at $0 (cacheWrite already fell back to
  // the input rate). Every major provider prices cache reads at ~10% of input
  // (Anthropic, OpenAI GPT-5 "cached input"), so use that rather than nothing.
  const cacheReadRate =
    pricing.cacheRead == null
      ? resolvePerMillionRate(pricing.input, cacheReadTokens) * kCacheReadInputRatioFallback
      : resolvePerMillionRate(pricing.cacheRead, cacheReadTokens);
  const cacheReadCost = (cacheReadTokens / kTokensPerMillion) * cacheReadRate;
  const cacheWriteRate = resolvePerMillionRate(
    pricing.cacheWrite == null ? pricing.input : pricing.cacheWrite,
    cacheWriteTokens,
  );
  const cacheWriteCost =
    (cacheWriteTokens / kTokensPerMillion) * cacheWriteRate;
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    pricingFound: true,
  };
};

module.exports = {
  kGlobalModelPricing,
  deriveCostBreakdown,
  resolvePricingFromOpenclawNodeModules,
  loadOpenclawNodeModulesPricingMap,
};
