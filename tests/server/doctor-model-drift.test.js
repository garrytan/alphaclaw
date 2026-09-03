const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildModelDriftCards,
  collectConfiguredModels,
} = require("../../lib/server/doctor/model-drift");
const {
  canonicalizeAnthropicModelId,
  getAnthropicRegistryEntry,
  findNewerSameTierEntry,
  validateRegistryOntology,
} = require("../../lib/server/doctor/model-registry");
const {
  computeWorkspaceSnapshotBounded,
} = require("../../lib/server/doctor/workspace-fingerprint");

const kCatalogCurrent = [
  { key: "anthropic/claude-opus-5", provider: "anthropic", label: "Claude Opus 5" },
  { key: "anthropic/claude-opus-4-8", provider: "anthropic", label: "Claude Opus 4.8" },
  { key: "anthropic/claude-sonnet-5", provider: "anthropic", label: "Claude Sonnet 5" },
  { key: "anthropic/claude-haiku-4-5", provider: "anthropic", label: "Claude Haiku 4.5" },
  { key: "claude-cli/claude-opus-5", provider: "claude-cli", label: "Claude Opus 5 (Claude CLI)" },
  { key: "openai/gpt-5.5", provider: "openai", label: "GPT-5.5" },
];

const findCard = (cards, prefix) =>
  cards.find((card) => card.sourceKey.startsWith(prefix));

describe("server/doctor/model-registry", () => {
  it("has a self-consistent ontology (unique ids, exclusive tiers, current heads)", () => {
    expect(validateRegistryOntology()).toEqual([]);
  });

  it("canonicalizes provider prefixes, dots, dates, and platform decorations", () => {
    expect(canonicalizeAnthropicModelId("anthropic/claude-opus-4-6")).toBe(
      "claude-opus-4-6",
    );
    expect(canonicalizeAnthropicModelId("github-copilot/claude-opus-4.6")).toBe(
      "claude-opus-4-6",
    );
    expect(
      canonicalizeAnthropicModelId("us.anthropic.claude-opus-4-8-v1:0"),
    ).toBe("claude-opus-4-8");
    expect(
      canonicalizeAnthropicModelId("anthropic/claude-haiku-4-5-20251001"),
    ).toBe("claude-haiku-4-5");
    expect(canonicalizeAnthropicModelId("claude-3-5-haiku-20241022")).toBe(
      "claude-haiku-3-5",
    );
    expect(canonicalizeAnthropicModelId("claude-fable-5")).toBe("claude-fable-5");
    expect(canonicalizeAnthropicModelId("openai/gpt-5.5")).toBeNull();
    expect(canonicalizeAnthropicModelId("")).toBeNull();
  });

  it("rejects lookalike tokens (boundary before, unconsumed suffix after)", () => {
    // "claude-" mid-token is not a Claude model.
    expect(canonicalizeAnthropicModelId("vendor/notclaude-opus-4-5")).toBeNull();
    // A longer hyphenated token merely embedding a model id is not a
    // reference to that model.
    expect(canonicalizeAnthropicModelId("claude-opus-4-6-migration")).toBeNull();
    expect(
      canonicalizeAnthropicModelId("vendor/claude-opus-4-5-garbage"),
    ).toBeNull();
  });

  it("strips Vertex @date and -latest decorations, rejects bare tier words, prefers the earliest match", () => {
    expect(canonicalizeAnthropicModelId("claude-opus-4-6@20260101")).toBe(
      "claude-opus-4-6",
    );
    expect(canonicalizeAnthropicModelId("anthropic/claude-sonnet-5-latest")).toBe(
      "claude-sonnet-5",
    );
    expect(canonicalizeAnthropicModelId("anthropic/claude-opus")).toBeNull();
    // A string carrying both id forms resolves its FIRST id.
    expect(
      canonicalizeAnthropicModelId("claude-3-5-haiku then claude-opus-5"),
    ).toBe("claude-haiku-3-5");
  });

  it("detects every ontology violation class (validator negative paths)", () => {
    const entry = (overrides) => ({
      id: "claude-opus-5",
      label: "X",
      tier: "opus",
      generation: "5",
      status: "current",
      contextWindow: null,
      maxOutputTokens: null,
      ...overrides,
    });
    expect(
      validateRegistryOntology({
        registry: [entry({}), entry({ generation: "4.8" })],
        tiers: ["opus"],
      }),
    ).toContain("duplicate registry id: claude-opus-5");
    expect(
      validateRegistryOntology({
        registry: [entry({ tier: "mega" })],
        tiers: ["opus"],
      }),
    ).toEqual(
      expect.arrayContaining([
        'unknown tier "mega" on claude-opus-5',
        'tier "opus" has no models',
      ]),
    );
    expect(
      validateRegistryOntology({
        registry: [entry({}), entry({ id: "claude-opus-5b" })],
        tiers: ["opus"],
      }),
    ).toContain("overlapping tier/generation: opus:5");
    expect(
      validateRegistryOntology({
        registry: [entry({ status: "legacy" })],
        tiers: ["opus"],
      }),
    ).toContain('tier "opus" newest entry claude-opus-5 is not current');
  });

  it("classifies opus 4.6 as deprecated and resolves availability-gated successors by declaration order", () => {
    const entry = getAnthropicRegistryEntry("anthropic/claude-opus-4-6");
    expect(entry.status).toBe("deprecated");
    expect(entry.tier).toBe("opus");
    const available = new Set(["claude-opus-4-8"]);
    expect(findNewerSameTierEntry(entry, available).id).toBe("claude-opus-4-8");
    expect(
      findNewerSameTierEntry(entry, new Set(["claude-sonnet-5"])),
    ).toBeNull();
    // Unrestricted: the newest same-tier entry wins (declaration order, no
    // float version math).
    expect(findNewerSameTierEntry(entry).id).toBe("claude-opus-5");
    // A deprecated model is never offered as a successor.
    const opus45 = getAnthropicRegistryEntry("claude-opus-4-5");
    expect(
      findNewerSameTierEntry(opus45, new Set(["claude-opus-4-6"])),
    ).toBeNull();
  });
});

describe("server/doctor/model-drift", () => {
  let workspaceRoot;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-model-drift-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const writeSkill = (location, content) => {
    const dir = path.join(workspaceRoot, "skills", location);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
  };

  const build = (overrides = {}) =>
    buildModelDriftCards({
      catalogModels: kCatalogCurrent,
      workspaceRoot,
      ...overrides,
    });

  it("collects primary, fallback, and enabled bindings across scopes", () => {
    const rows = collectConfiguredModels({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.5"] },
          models: { "anthropic/claude-sonnet-5": {} },
        },
        list: [
          { id: "research", model: { primary: "anthropic/claude-sonnet-4-6" } },
          { id: "weird id!", model: { primary: "anthropic/claude-opus-5" } },
        ],
      },
    });
    expect(rows).toEqual([
      { scope: "defaults", role: "primary", key: "anthropic/claude-opus-4-6" },
      { scope: "defaults", role: "fallback", key: "openai/gpt-5.5" },
      { scope: "defaults", role: "enabled", key: "anthropic/claude-sonnet-5" },
      { scope: "agent research", role: "primary", key: "anthropic/claude-sonnet-4-6" },
      { scope: "agent #1", role: "primary", key: "anthropic/claude-opus-5" },
    ]);
  });

  it("flags a deprecated primary binding as P1 with an available successor", () => {
    const cards = build({
      config: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-opus-4-6" } },
        },
      },
    });
    const card = findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6");
    expect(card).toBeTruthy();
    expect(card.priority).toBe("P1");
    expect(card.category).toBe("model drift");
    expect(card.recommendation).toContain("anthropic/claude-opus-5");
    expect(card.fixPrompt).toContain("anthropic/claude-opus-5");
    expect(card.source).toBe("deterministic");
  });

  it("keeps the successor on the configured key's provider", () => {
    const cards = build({
      config: {
        agents: {
          defaults: { model: { primary: "claude-cli/claude-opus-4-6" } },
        },
      },
    });
    const card = findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6");
    expect(card.fixPrompt).toContain("claude-cli/claude-opus-5");
  });

  it("never names a cross-provider successor key (falls back to the generic prompt)", () => {
    // openrouter is in the catalog (other rows could exist) but has no
    // opus-5 row — the successor exists only on anthropic/. The fixPrompt
    // must not move the binding onto another provider's key.
    const cards = build({
      config: {
        agents: {
          defaults: { model: { primary: "openrouter/anthropic/claude-opus-4-6" } },
        },
      },
    });
    const card = findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6");
    expect(card).toBeTruthy();
    expect(card.fixPrompt).not.toContain("anthropic/claude-opus-5");
    expect(card.fixPrompt).toContain("SAME provider");
  });

  it("uses the generic prompt when one model is bound across multiple providers", () => {
    const cards = build({
      config: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-opus-4-6" } },
          list: [
            { id: "cli", model: { primary: "claude-cli/claude-opus-4-6" } },
          ],
        },
      },
    });
    const card = findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6");
    expect(card).toBeTruthy();
    // One card for the canonical model, no single provider's key rewriting
    // the other provider's binding.
    expect(card.fixPrompt).not.toContain("with anthropic/claude-opus-5");
    expect(card.fixPrompt).not.toContain("with claude-cli/claude-opus-5");
    expect(card.fixPrompt).toContain("SAME provider");
  });

  it("nudges (P2) under a severity-distinct sourceKey, and stays quiet without a successor", () => {
    const withNewer = build({
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
      },
    });
    const nudge = findCard(withNewer, "det:model-drift:binding-newer:claude-opus-4-8");
    expect(nudge).toBeTruthy();
    expect(nudge.priority).toBe("P2");
    expect(nudge.recommendation).toContain("Claude Opus 5");
    // Dismissing the mild nudge must never suppress a future P1: the two
    // severities live on different sourceKeys.
    expect(
      findCard(withNewer, "det:model-drift:binding-deprecated:claude-opus-4-8"),
    ).toBeUndefined();

    const withoutNewer = build({
      catalogModels: [
        { key: "anthropic/claude-opus-4-8", provider: "anthropic", label: "Claude Opus 4.8" },
      ],
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
      },
    });
    expect(
      findCard(withoutNewer, "det:model-drift:binding-newer:claude-opus-4-8"),
    ).toBeUndefined();
  });

  it("does not nudge an enabled-models allowlist row (only primaries)", () => {
    const cards = build({
      config: {
        agents: {
          defaults: { models: { "anthropic/claude-opus-4-8": {} } },
        },
      },
    });
    expect(
      findCard(cards, "det:model-drift:binding-newer:claude-opus-4-8"),
    ).toBeUndefined();
  });

  it("flags malformed and unknown model codings", () => {
    const cards = build({
      config: {
        agents: {
          defaults: { model: { primary: "not a model key" } },
          list: [
            { id: "typo", model: { primary: "anthropic/claude-opus-9-9" } },
            { id: "custom", model: { primary: "myprov/local-llm" } },
          ],
        },
        models: { providers: { myprov: { models: [{ id: "local-llm", contextWindow: 32768 }] } } },
      },
    });
    const invalidCards = cards.filter((card) =>
      card.sourceKey.startsWith("det:model-drift:invalid"),
    );
    expect(invalidCards).toHaveLength(2);
    const malformed = invalidCards.find((card) => card.summary.includes("grammar"));
    expect(malformed.priority).toBe("P1");
    const unknownAnthropic = invalidCards.find((card) =>
      card.summary.includes("claude-opus-9-9"),
    );
    expect(unknownAnthropic.priority).toBe("P1");
    // myprov/local-llm is declared under models.providers — never flagged.
    expect(
      invalidCards.some((card) => card.summary.includes("local-llm")),
    ).toBe(false);
  });

  it("validates custom-provider bindings against the provider's declared model list", () => {
    const cards = build({
      config: {
        agents: {
          defaults: { model: { primary: "myprov/typo-model" } },
          list: [{ id: "opaque", model: { primary: "opaqueprov/anything" } }],
        },
        models: {
          providers: {
            myprov: { models: [{ id: "good-model", contextWindow: 32768 }] },
            // No parseable model list: cannot judge, never flagged.
            opaqueprov: { baseUrl: "http://localhost:9999" },
          },
        },
      },
    });
    const invalidCards = cards.filter((card) =>
      card.sourceKey.startsWith("det:model-drift:invalid"),
    );
    expect(invalidCards).toHaveLength(1);
    expect(invalidCards[0].priority).toBe("P2");
    expect(invalidCards[0].summary).toContain("does not declare");
    expect(invalidCards[0].summary).toContain("typo-model");
  });

  it("skips catalog-miss flags for providers the catalog view does not carry at all", () => {
    // The live catalog filters whole providers out (e.g. claude-cli):
    // a binding there is unjudgeable, not invalid.
    const liveFiltered = kCatalogCurrent.filter((row) => row.provider !== "claude-cli");
    const cards = build({
      catalogModels: liveFiltered,
      config: {
        agents: { defaults: { model: { primary: "claude-cli/claude-nova-9" } } },
      },
    });
    expect(
      cards.some((card) => card.sourceKey.startsWith("det:model-drift:invalid")),
    ).toBe(false);
    // With the provider present (bootstrap-like view), the same key IS flagged.
    const withProvider = build({
      config: {
        agents: { defaults: { model: { primary: "claude-cli/claude-nova-9" } } },
      },
    });
    expect(
      withProvider.some((card) => card.sourceKey.startsWith("det:model-drift:invalid")),
    ).toBe(true);
  });

  it("hedges catalog-miss copy when judging against the bundled bootstrap snapshot", () => {
    const cards = build({
      catalogSource: "bootstrap",
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-9-9" } } },
      },
    });
    const card = findCard(cards, "det:model-drift:invalid");
    expect(card.summary).toContain("bundled catalog snapshot");
    const liveCards = build({
      catalogSource: "openclaw",
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-9-9" } } },
      },
    });
    expect(findCard(liveCards, "det:model-drift:invalid").summary).not.toContain(
      "bundled catalog snapshot",
    );
  });

  it("reports taxonomy violations (provider mismatch, unclassified anthropic rows) but not dated aliases", () => {
    const cards = build({
      catalogModels: [
        ...kCatalogCurrent,
        // Dated alias of an existing row with the same label: allowed.
        {
          key: "anthropic/claude-haiku-4-5-20251001",
          provider: "anthropic",
          label: "Claude Haiku 4.5",
        },
        // Provider field disagrees with the key prefix.
        { key: "openai/gpt-5.4", provider: "google", label: "GPT-5.4" },
        // Anthropic row the ontology cannot classify.
        { key: "anthropic/claude-nova-7", provider: "anthropic", label: "Claude Nova 7" },
      ],
    });
    const card = findCard(cards, "det:model-drift:taxonomy:");
    expect(card).toBeTruthy();
    const evidenceText = card.evidence.map((entry) => entry.text).join("\n");
    expect(evidenceText).toContain("provider mismatch: openai/gpt-5.4");
    expect(evidenceText).toContain("unclassified anthropic model: anthropic/claude-nova-7");
    expect(evidenceText).not.toContain("claude-haiku-4-5-20251001");
  });

  it("emits no taxonomy card for a clean catalog", () => {
    const cards = build({});
    expect(findCard(cards, "det:model-drift:taxonomy:")).toBeUndefined();
  });

  it("flags first-party catalog limits that disagree with documented limits — proxies exempt", () => {
    const cards = build({
      catalogModels: [
        {
          key: "anthropic/claude-sonnet-4-6",
          provider: "anthropic",
          label: "Claude Sonnet 4.6",
          contextWindow: 200000,
          maxTokens: 32000,
        },
        {
          key: "anthropic/claude-opus-5",
          provider: "anthropic",
          label: "Claude Opus 5",
          contextWindow: 1000000,
        },
        // A proxy provider legitimately re-caps context: never a mismatch.
        {
          key: "openrouter/anthropic/claude-sonnet-4-6",
          provider: "openrouter",
          label: "Claude Sonnet 4.6 (OpenRouter)",
          contextWindow: 128000,
        },
      ],
    });
    const card = findCard(cards, "det:model-drift:context-catalog:");
    expect(card).toBeTruthy();
    const evidenceText = card.evidence.map((entry) => entry.text).join("\n");
    expect(evidenceText).toContain("anthropic/claude-sonnet-4-6: catalog says 200000 context tokens");
    expect(evidenceText).toContain("32000 max output tokens");
    expect(evidenceText).not.toContain("openrouter");
    expect(evidenceText).not.toContain("claude-opus-5");
  });

  it("flags custom provider models without a usable max context size", () => {
    const cards = build({
      config: {
        models: {
          providers: {
            myprov: {
              models: [
                { id: "good-model", contextWindow: 128000 },
                { id: "no-context" },
                { id: "absurd", contextWindow: 3 },
              ],
            },
          },
        },
      },
    });
    const card = findCard(cards, "det:model-drift:context-custom:");
    expect(card).toBeTruthy();
    const evidenceText = card.evidence.map((entry) => entry.text).join("\n");
    expect(evidenceText).toContain("myprov/no-context: contextWindow is not set");
    expect(evidenceText).toContain("myprov/absurd");
    expect(evidenceText).not.toContain("good-model");
  });

  it("honors a provider-level contextWindow default (inheritance is valid config)", () => {
    const cards = build({
      config: {
        models: {
          providers: {
            myprov: {
              contextWindow: 128000,
              models: [{ id: "inherits" }],
            },
            otherprov: {
              defaults: { contextWindow: 64000 },
              models: [{ id: "also-inherits" }],
            },
          },
        },
      },
    });
    expect(findCard(cards, "det:model-drift:context-custom:")).toBeUndefined();
  });

  it("flags skills referencing deprecated models with replacement guidance", () => {
    writeSkill("deploy-bot", "---\nname: deploy-bot\n---\nAlways use claude-opus-4-6 for reviews.\n");
    writeSkill("fresh", "---\nname: fresh\n---\nUse anthropic/claude-opus-5.\n");
    const cards = build({});
    const card = findCard(cards, "det:model-drift:skill:deploy-bot:");
    expect(card).toBeTruthy();
    expect(card.priority).toBe("P2");
    expect(card.sourceKey).toMatch(/^det:model-drift:skill:deploy-bot:[0-9a-f]{24}$/);
    expect(card.fixPrompt).toContain("skills/deploy-bot/SKILL.md");
    expect(card.fixPrompt).toContain("claude-opus-4-6 with claude-opus-5");
    expect(card.targetPaths).toEqual([{ path: "skills/deploy-bot/SKILL.md" }]);
    expect(findCard(cards, "det:model-drift:skill:fresh")).toBeUndefined();
  });

  it("flags a legacy model reference in a skill only when its successor is installed", () => {
    writeSkill("reviewer", "Use claude-sonnet-4-6 here.\n");
    const withSuccessor = build({});
    expect(findCard(withSuccessor, "det:model-drift:skill:reviewer")).toBeTruthy();
    const withoutSuccessor = build({
      catalogModels: [
        {
          key: "anthropic/claude-sonnet-4-6",
          provider: "anthropic",
          label: "Claude Sonnet 4.6",
        },
      ],
    });
    expect(
      findCard(withoutSuccessor, "det:model-drift:skill:reviewer"),
    ).toBeUndefined();
  });

  it("filters non-actionable skills BEFORE the card cap so deprecated findings are never crowded out", () => {
    // Catalog without sonnet-5: legacy sonnet-4-6 references are not
    // actionable and must not consume the capped card slots.
    const catalog = [
      { key: "anthropic/claude-opus-5", provider: "anthropic", label: "Claude Opus 5" },
      { key: "anthropic/claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6" },
    ];
    for (let index = 0; index < 9; index += 1) {
      writeSkill(`legacy-${index}`, "Prefer claude-sonnet-4-6 for this.\n");
    }
    writeSkill("zz-deprecated", "Use claude-opus-4-6 here.\n");
    const cards = build({ catalogModels: catalog });
    expect(findCard(cards, "det:model-drift:skill:zz-deprecated:")).toBeTruthy();
    expect(
      cards.filter((card) => card.sourceKey.startsWith("det:model-drift:skill:")),
    ).toHaveLength(1);
  });

  it("routes every display-bound value through the injected sanitizer", () => {
    const marking = (text) => `S[${text}]`;
    const cards = build({
      sanitize: marking,
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
      },
    });
    const card = findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6");
    expect(card.summary).toContain("S[anthropic/claude-opus-4-6]");
    expect(card.evidence[0].text).toContain("S[anthropic/claude-opus-4-6]");
  });

  it("never names a successor key that fails the token shape — not even in display copy", () => {
    // A hostile custom-provider row can surface in the semi-trusted catalog
    // and still canonicalize to a real successor id.
    const hostileKey = "anthropic/claude-opus-5 injected advice";
    const cards = build({
      catalogModels: [
        { key: hostileKey, provider: "anthropic", label: "Claude Opus 5" },
      ],
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
      },
    });
    const card = findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6");
    expect(card).toBeTruthy();
    expect(card.recommendation).not.toContain("injected");
    expect(card.fixPrompt).not.toContain("injected");
    expect(card.fixPrompt).toContain("SAME provider");
  });

  it("recommends an OpenClaw upgrade when the successor is not installed at all", () => {
    const cards = build({
      catalogModels: [
        { key: "anthropic/claude-sonnet-5", provider: "anthropic", label: "Claude Sonnet 5" },
      ],
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
      },
    });
    const card = findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6");
    expect(card.recommendation).toContain("upgrade OpenClaw");
    expect(card.recommendation).toContain("claude-opus-5");
    expect(card.fixPrompt).toContain("SAME provider");
  });

  it("caps binding evidence at 10 rows", () => {
    const cards = build({
      config: {
        agents: {
          list: Array.from({ length: 12 }, (_, index) => ({
            id: `agent-${index}`,
            model: { primary: "anthropic/claude-opus-4-6" },
          })),
        },
      },
    });
    const card = findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6");
    expect(card.evidence).toHaveLength(10);
  });

  it("emits the plain catalog-miss P2 variant for non-Anthropic keys", () => {
    const cards = build({
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-9-fake" } } },
      },
    });
    const card = findCard(cards, "det:model-drift:invalid-missing:");
    expect(card).toBeTruthy();
    expect(card.priority).toBe("P2");
    expect(card.summary).toContain("does not offer");
  });

  it("dedupes repeated keys and caps invalid-coding cards at 6", () => {
    const list = Array.from({ length: 8 }, (_, index) => ({
      id: `agent-${index}`,
      model: { primary: `bad key number ${index % 7}` },
    }));
    const cards = build({ config: { agents: { list } } });
    const invalidCards = cards.filter((card) =>
      card.sourceKey.startsWith("det:model-drift:invalid"),
    );
    expect(invalidCards).toHaveLength(6);
  });

  it("handles models.providers model lists in object-map form at both check sites", () => {
    const cards = build({
      config: {
        agents: { defaults: { model: { primary: "myprov/typo-model" } } },
        models: {
          providers: {
            myprov: { models: { "good-model": { contextWindow: 128000 }, "no-context": {} } },
          },
        },
      },
    });
    expect(findCard(cards, "det:model-drift:invalid-undeclared:")).toBeTruthy();
    const contextCard = findCard(cards, "det:model-drift:context-custom:");
    expect(contextCard.evidence.map((entry) => entry.text).join("\n")).toContain(
      "myprov/no-context",
    );
  });

  it("flags an implausibly large custom contextWindow", () => {
    const cards = build({
      config: {
        models: {
          providers: { myprov: { models: [{ id: "huge", contextWindow: 50000000 }] } },
        },
      },
    });
    expect(findCard(cards, "det:model-drift:context-custom:")).toBeTruthy();
  });

  it("reports duplicate keys, missing labels, and ambiguous labels in the taxonomy card", () => {
    const cards = build({
      catalogModels: [
        ...kCatalogCurrent,
        { key: "openai/gpt-5.5", provider: "openai", label: "GPT-5.5" },
        { key: "openai/gpt-5.4", provider: "openai", label: "" },
        { key: "openai/gpt-5.3", provider: "openai", label: "GPT Duo" },
        { key: "openai/gpt-5.2", provider: "openai", label: "GPT Duo" },
      ],
    });
    const card = findCard(cards, "det:model-drift:taxonomy:");
    const evidenceText = card.evidence.map((entry) => entry.text).join("\n");
    expect(evidenceText).toContain("duplicate catalog key: openai/gpt-5.5");
    expect(evidenceText).toContain("missing label: openai/gpt-5.4");
    expect(evidenceText).toContain('ambiguous label "GPT Duo" under openai');
  });

  it("routes unsafe skill locations to the generic fixPrompt with no targetPaths", () => {
    writeSkill("evil skill", "Use claude-opus-4-6 here.\n");
    const cards = build({});
    const card = cards.find((c) => c.sourceKey.startsWith("det:model-drift:skill:"));
    expect(card).toBeTruthy();
    expect(card.targetPaths).toEqual([]);
    expect(card.fixPrompt).not.toContain("evil skill");
    expect(card.sourceKey).toMatch(/^det:model-drift:skill:[0-9a-f]{24}:[0-9a-f]{24}$/);
  });

  it("handles a SKILL.md at the skills root without a double-slash path", () => {
    fs.mkdirSync(path.join(workspaceRoot, "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, "skills", "SKILL.md"),
      "Use claude-opus-4-6.\n",
      "utf8",
    );
    const cards = build({});
    const card = cards.find((c) => c.sourceKey.startsWith("det:model-drift:skill:"));
    expect(card).toBeTruthy();
    expect(card.targetPaths).toEqual([{ path: "skills/SKILL.md" }]);
    expect(card.fixPrompt).toContain("skills/SKILL.md");
  });

  it("annotates the last card with overflow and truncation notes", () => {
    for (let index = 0; index < 9; index += 1) {
      writeSkill(`stale-${index}`, "Use claude-opus-4-6.\n");
    }
    const overflowCards = build({}).filter((card) =>
      card.sourceKey.startsWith("det:model-drift:skill:"),
    );
    expect(overflowCards).toHaveLength(8);
    expect(overflowCards.at(-1).summary).toContain("1 more skill");

    // Truncation: budget of 3 dirents = one skill dir + its SKILL.md, then cap.
    const truncatedCards = build({ skillsScanMaxVisitedDirents: 3 }).filter((card) =>
      card.sourceKey.startsWith("det:model-drift:skill:"),
    );
    expect(truncatedCards.length).toBeGreaterThan(0);
    expect(truncatedCards.at(-1).summary).toContain("safety cap");
  });

  it("refuses to walk a skills root that symlinks outside the workspace", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-md-outside-"));
    try {
      fs.mkdirSync(path.join(outside, "escaped"), { recursive: true });
      fs.writeFileSync(
        path.join(outside, "escaped", "SKILL.md"),
        "Use claude-opus-4-6.\n",
        "utf8",
      );
      fs.symlinkSync(outside, path.join(workspaceRoot, "skills"));
      const cards = build({});
      expect(
        cards.some((card) => card.sourceKey.startsWith("det:model-drift:skill:")),
      ).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("collects a singular scope.model.fallback binding", () => {
    const rows = collectConfiguredModels({
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5", fallback: "anthropic/claude-haiku-4-5" } },
      },
    });
    expect(rows).toContainEqual({
      scope: "defaults",
      role: "fallback",
      key: "anthropic/claude-haiku-4-5",
    });
  });

  it("ignores lookalike tokens in skill text (boundaries checked against the original content)", () => {
    writeSkill(
      "lookalikes",
      "See vendor/notclaude-opus-4-5 and the claude-opus-4-6-migration guide.\n",
    );
    const cards = build({});
    expect(
      cards.some((card) => card.sourceKey.startsWith("det:model-drift:skill:")),
    ).toBe(false);
  });

  it("never nudges a current-status binding (transition tiers carry several current models)", () => {
    const cards = build({
      catalogModels: [
        ...kCatalogCurrent,
        { key: "anthropic/claude-haiku-4-6", provider: "anthropic", label: "Claude Haiku 4.6" },
      ],
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-haiku-4-5" } } },
      },
    });
    expect(findCard(cards, "det:model-drift:binding-newer:claude-haiku-4-5")).toBeUndefined();
  });

  it("accepts the string shorthand binding form (model: \"provider/model\")", () => {
    const cards = build({
      config: { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } },
    });
    expect(
      findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6"),
    ).toBeTruthy();
  });

  it("keeps the object-map key as a declared id even when the def carries its own id", () => {
    const cards = build({
      config: {
        agents: {
          defaults: { model: { primary: "myprov/model-a" } },
        },
        models: {
          providers: {
            myprov: { models: { "model-a": { id: "upstream-alias", contextWindow: 32768 } } },
          },
        },
      },
    });
    expect(
      cards.some((card) => card.sourceKey.startsWith("det:model-drift:invalid")),
    ).toBe(false);
  });

  it("never offers an available:false catalog row as a successor", () => {
    const cards = build({
      catalogModels: [
        {
          key: "anthropic/claude-opus-5",
          provider: "anthropic",
          label: "Claude Opus 5",
          available: false,
        },
        { key: "anthropic/claude-opus-4-8", provider: "anthropic", label: "Claude Opus 4.8" },
      ],
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
      },
    });
    const card = findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6");
    expect(card.recommendation).toContain("anthropic/claude-opus-4-8");
    expect(card.recommendation).not.toContain("anthropic/claude-opus-5`");
  });

  it("judges successor availability on the binding's own provider", () => {
    const cards = build({
      catalogModels: [
        {
          key: "openrouter/anthropic/claude-opus-4-8",
          provider: "openrouter",
          label: "Claude Opus 4.8 (OpenRouter)",
        },
        { key: "anthropic/claude-opus-5", provider: "anthropic", label: "Claude Opus 5" },
      ],
      config: {
        agents: {
          defaults: { model: { primary: "openrouter/anthropic/claude-opus-4-6" } },
        },
      },
    });
    const card = findCard(cards, "det:model-drift:binding-deprecated:claude-opus-4-6");
    // Opus 5 exists only on ANOTHER provider — the recommendation must name
    // the newest successor on the binding's own provider instead.
    expect(card.recommendation).toContain("Claude Opus 4.8");
    expect(card.recommendation).toContain("openrouter/anthropic/claude-opus-4-8");
    expect(card.recommendation).not.toContain("anthropic/claude-opus-5`");
  });

  it("flags an explicit implausible per-model contextWindow despite a provider default", () => {
    const cards = build({
      config: {
        models: {
          providers: {
            myprov: {
              contextWindow: 128000,
              models: [{ id: "inherits" }, { id: "broken", contextWindow: 3 }],
            },
          },
        },
      },
    });
    const card = findCard(cards, "det:model-drift:context-custom:");
    expect(card).toBeTruthy();
    const evidenceText = card.evidence.map((entry) => entry.text).join("\n");
    expect(evidenceText).toContain("myprov/broken");
    expect(evidenceText).not.toContain("inherits");
  });

  it("checks the declared list even when a stale catalog still carries the key", () => {
    const cards = build({
      catalogModels: [
        ...kCatalogCurrent,
        { key: "myprov/removed-model", provider: "myprov", label: "Removed" },
      ],
      config: {
        agents: { defaults: { model: { primary: "myprov/removed-model" } } },
        models: {
          providers: { myprov: { models: [{ id: "good-model", contextWindow: 32768 }] } },
        },
      },
    });
    expect(findCard(cards, "det:model-drift:invalid-undeclared:")).toBeTruthy();
  });

  it("hedges catalog-miss copy on a stale cache source too", () => {
    const cards = build({
      catalogSource: "cache",
      config: {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-9-9" } } },
      },
    });
    expect(findCard(cards, "det:model-drift:invalid-unknown:").summary).toContain(
      "cached catalog listing",
    );
  });

  it("annotates the last invalid-coding card with the suppressed overflow count", () => {
    const list = Array.from({ length: 8 }, (_, index) => ({
      id: `agent-${index}`,
      model: { primary: `bad key ${index}` },
    }));
    const cards = build({ config: { agents: { list } } });
    const invalidCards = cards.filter((card) =>
      card.sourceKey.startsWith("det:model-drift:invalid"),
    );
    expect(invalidCards).toHaveLength(6);
    expect(invalidCards.at(-1).summary).toContain("2 more bindings");
  });

  it("warns loudly when a sub-check throws and keeps sibling checks alive", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const poisonedConfig = Object.defineProperty({}, "agents", {
        get() {
          throw new Error("boom");
        },
      });
      const cards = buildModelDriftCards({
        config: poisonedConfig,
        catalogModels: [
          // Taxonomy violation proves the sibling check still ran.
          { key: "openai/gpt-5.4", provider: "google", label: "GPT-5.4" },
        ],
        workspaceRoot,
      });
      expect(findCard(cards, "det:model-drift:taxonomy:")).toBeTruthy();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("model-drift config-bindings check failed"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("fails soft on malformed config and empty inputs", () => {
    expect(
      buildModelDriftCards({
        config: { agents: { list: "nope", defaults: 42 }, models: { providers: null } },
        catalogModels: null,
        workspaceRoot,
      }),
    ).toEqual([]);
    expect(buildModelDriftCards()).toEqual([]);
  });
});

describe("server/doctor/model-drift service integration", () => {
  let currentDoctorDb = null;

  const loadFresh = (relativePath) => {
    const modulePath = require.resolve(relativePath);
    delete require.cache[modulePath];
    return require(modulePath);
  };

  afterEach(() => {
    if (currentDoctorDb?.closeDoctorDb) {
      currentDoctorDb.closeDoctorDb();
      currentDoctorDb = null;
    }
  });

  it("emits model-drift cards from real scans and honors sourceKey dismissal", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-md-ws-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-md-db-"));
    try {
      fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");
      const doctorDb = loadFresh("../../lib/server/db/doctor");
      currentDoctorDb = doctorDb;
      doctorDb.initDoctorDb({ rootDir: dbRoot });
      const { createDoctorService } = loadFresh("../../lib/server/doctor/service");
      const clawCmd = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({ summary: "No findings", cards: [] }),
      }));
      const doctorService = createDoctorService({
        clawCmd,
        listDoctorRuns: doctorDb.listDoctorRuns,
        listDoctorRunSummaries: doctorDb.listDoctorRunSummaries,
        getDoctorRunManifest: doctorDb.getDoctorRunManifest,
        getLatestCompletedRunSummary: doctorDb.getLatestCompletedRunSummary,
        listDoctorCards: doctorDb.listDoctorCards,
        getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
        setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
        createDoctorRun: doctorDb.createDoctorRun,
        completeDoctorRun: doctorDb.completeDoctorRun,
        insertDoctorCards: doctorDb.insertDoctorCards,
        getDoctorRun: doctorDb.getDoctorRun,
        getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
        getDoctorCard: doctorDb.getDoctorCard,
        updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
        workspaceRoot,
        managedRoot: workspaceRoot,
        computeSnapshotAsync: (root, opts) =>
          computeWorkspaceSnapshotBounded(root, { ...(opts || {}), batchPauseMs: 0 }),
        readOpenclawConfig: () => ({
          agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
        }),
      });
      // Late DI, exactly like route wiring registers the shared cache.
      doctorService.registerModelCatalog({
        peekCatalog: () => ({
          models: [
            { key: "anthropic/claude-opus-5", provider: "anthropic", label: "Claude Opus 5" },
          ],
          source: "openclaw",
        }),
      });

      // runDoctor resolves at run START; the scan completes asynchronously.
      const awaitRunCompleted = async (runId) => {
        await vi.waitFor(() => {
          expect(doctorDb.getDoctorRun(runId).status).toBe("completed");
        });
      };
      const firstRun = await doctorService.runDoctor();
      expect(firstRun.ok).toBe(true);
      await awaitRunCompleted(firstRun.runId);
      const firstCards = doctorDb.getDoctorCardsByRunId(firstRun.runId);
      const driftCard = firstCards.find(
        (card) => card.sourceKey === "det:model-drift:binding-deprecated:claude-opus-4-6",
      );
      expect(driftCard).toBeTruthy();
      expect(driftCard.priority).toBe("P1");
      expect(driftCard.fixPrompt).toContain("anthropic/claude-opus-5");

      // Dismissal suppression: the same sourceKey is never re-emitted.
      doctorDb.updateDoctorCardStatus({ id: driftCard.id, status: "dismissed" });
      const secondRun = await doctorService.runDoctor();
      expect(secondRun.ok).toBe(true);
      await awaitRunCompleted(secondRun.runId);
      const secondCards = doctorDb.getDoctorCardsByRunId(secondRun.runId);
      expect(
        secondCards.some(
          (card) =>
            card.sourceKey === "det:model-drift:binding-deprecated:claude-opus-4-6",
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(dbRoot, { recursive: true, force: true });
    }
  });
});

describe("server/doctor/model-drift catalog fallback", () => {
  let currentDoctorDb = null;

  afterEach(() => {
    if (currentDoctorDb?.closeDoctorDb) {
      currentDoctorDb.closeDoctorDb();
      currentDoctorDb = null;
    }
  });

  it("falls back to the bundled bootstrap catalog when peekCatalog throws", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-md-fb-ws-"));
    const dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-md-fb-db-"));
    try {
      fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "# Guidance\n", "utf8");
      const loadFresh = (relativePath) => {
        const modulePath = require.resolve(relativePath);
        delete require.cache[modulePath];
        return require(modulePath);
      };
      const doctorDb = loadFresh("../../lib/server/db/doctor");
      currentDoctorDb = doctorDb;
      doctorDb.initDoctorDb({ rootDir: dbRoot });
      const { createDoctorService } = loadFresh("../../lib/server/doctor/service");
      const doctorService = createDoctorService({
        clawCmd: async () => ({
          ok: true,
          stdout: JSON.stringify({ summary: "No findings", cards: [] }),
        }),
        listDoctorRuns: doctorDb.listDoctorRuns,
        listDoctorCards: doctorDb.listDoctorCards,
        getInitialWorkspaceBaseline: doctorDb.getInitialWorkspaceBaseline,
        setInitialWorkspaceBaseline: doctorDb.setInitialWorkspaceBaseline,
        createDoctorRun: doctorDb.createDoctorRun,
        completeDoctorRun: doctorDb.completeDoctorRun,
        insertDoctorCards: doctorDb.insertDoctorCards,
        getDoctorRun: doctorDb.getDoctorRun,
        getDoctorCardsByRunId: doctorDb.getDoctorCardsByRunId,
        getDoctorCard: doctorDb.getDoctorCard,
        updateDoctorCardStatus: doctorDb.updateDoctorCardStatus,
        workspaceRoot,
        managedRoot: workspaceRoot,
        computeSnapshotAsync: (root, opts) =>
          computeWorkspaceSnapshotBounded(root, { ...(opts || {}), batchPauseMs: 0 }),
        readOpenclawConfig: () => ({
          agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
        }),
      });
      doctorService.registerModelCatalog({
        peekCatalog: () => {
          throw new Error("cache exploded");
        },
      });
      const run = await doctorService.runDoctor();
      expect(run.ok).toBe(true);
      await vi.waitFor(() => {
        expect(doctorDb.getDoctorRun(run.runId).status).toBe("completed");
      });
      const card = doctorDb
        .getDoctorCardsByRunId(run.runId)
        .find(
          (row) =>
            row.sourceKey === "det:model-drift:binding-deprecated:claude-opus-4-6",
        );
      expect(card).toBeTruthy();
      // The bundled bootstrap catalog carries opus-4-8 (not opus-5), so the
      // fallback path is visible in the successor the card names.
      expect(card.recommendation).toContain("anthropic/claude-opus-4-8");
      // And the catalog-miss hedge proves source === "bootstrap" flowed through.
      const missCard = doctorDb
        .getDoctorCardsByRunId(run.runId)
        .find((row) => row.sourceKey.startsWith("det:model-drift:invalid"));
      if (missCard) {
        expect(missCard.summary).toContain("bundled catalog snapshot");
      }
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      fs.rmSync(dbRoot, { recursive: true, force: true });
    }
  });
});

describe("server/model-catalog-cache peekCatalog", () => {
  it("serves the bundled fallback exec-free with an honest source", () => {
    const { createModelCatalogCache } = require("../../lib/server/model-catalog-cache");
    const shellCmd = vi.fn();
    const cache = createModelCatalogCache({
      shellCmd,
      gatewayEnv: () => ({}),
      parseJsonFromNoisyOutput: () => null,
      normalizeOnboardingModels: (models) => models,
      readOpenclawVersion: () => "",
      readOpenclawVersionAsync: async () => "",
      fallbackModels: [{ key: "anthropic/claude-opus-5", provider: "anthropic", label: "Claude Opus 5" }],
      cachePath: path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "model-cat-peek-")),
        "cache.json",
      ),
    });
    const peeked = cache.peekCatalog();
    expect(peeked.source).toBe("bootstrap");
    expect(peeked.models).toEqual([
      { key: "anthropic/claude-opus-5", provider: "anthropic", label: "Claude Opus 5" },
    ]);
    expect(shellCmd).not.toHaveBeenCalled();
  });

  it("reports a disk-loaded catalog as stale ('cache'), still exec-free", () => {
    const {
      createModelCatalogCache,
      kModelCatalogCacheVersion,
    } = require("../../lib/server/model-catalog-cache");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-cat-disk-"));
    const cachePath = path.join(cacheDir, "cache.json");
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        version: kModelCatalogCacheVersion,
        fetchedAt: 12345,
        openclawVersion: "2026.7.1-2",
        models: [
          { key: "anthropic/claude-opus-5", provider: "anthropic", label: "Claude Opus 5" },
        ],
      }),
      "utf8",
    );
    const shellCmd = vi.fn();
    const cache = createModelCatalogCache({
      shellCmd,
      gatewayEnv: () => ({}),
      parseJsonFromNoisyOutput: () => null,
      normalizeOnboardingModels: (models) => models,
      readOpenclawVersion: () => "",
      readOpenclawVersionAsync: async () => "",
      fallbackModels: [],
      cachePath,
    });
    const peeked = cache.peekCatalog();
    expect(peeked.source).toBe("cache");
    expect(peeked.models).toHaveLength(1);
    expect(shellCmd).not.toHaveBeenCalled();
  });
});
