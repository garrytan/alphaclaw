import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Models & keys: the key rows save through PATCH /api/env,
// one key per request, and the page's words never claim more than the model
// check proved.
const requests = [];
let envApp = null;
const readFixtures = new Map();
const refreshed = [];

vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0 };
  harness.begin = () => {
    harness.cursor = 0;
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
  };
  const useState = (initial) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      harness.slots[index],
      (next) => {
        harness.slots[index] = typeof next === "function" ? next(harness.slots[index]) : next;
      },
    ];
  };
  const useRef = (initial = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initial };
    return harness.slots[index];
  };
  return {
    useState,
    useRef,
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useLayoutEffect: () => {},
    __harness: harness,
  };
});
vi.mock("../../lib/public/js/lib/api/http.js", async (importOriginal) => {
  const request = (await import("supertest")).default;
  return {
    ...(await importOriginal()),
    authFetch: async (url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      requests.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : null });
      const res = await request(envApp)[method.toLowerCase()](url).send(options.body ? JSON.parse(options.body) : undefined);
      return { ok: res.status < 400, status: res.status, json: async () => res.body, text: async () => res.text };
    },
  };
});
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: (key) => ({
    data: readFixtures.get(key) ?? null,
    error: null,
    loading: false,
    refresh: async (options) => {
      refreshed.push([key, options]);
      return null;
    },
  }),
}));
vi.mock("../../lib/public/js/components/models-tab/use-models.js", () => ({
  useModels: vi.fn(),
  kCodexStatusCacheKey: "/api/codex/status",
}));

const express = (await import("express")).default;
const { registerEnvRoutes } = await import("../../lib/server/routes/env.js");
const preactHooks = await import("preact/hooks");
const { useModels } = await import("../../lib/public/js/components/models-tab/use-models.js");
const { patchEnvVar } = await import("../../lib/public/js/lib/api/envars.js");
const { ProviderKeyRow, ProviderKeyGroupHeading } = await import("../../lib/public/js/components/models-tab/provider-keys.js");
const { Models } = await import("../../lib/public/js/components/models-tab/index.js");
const { SecretInput } = await import("../../lib/public/js/components/secret-input.js");
const { ActionButton } = await import("../../lib/public/js/components/action-button.js");
const model = await import("../../lib/public/js/components/models-tab/model.js");

const harness = preactHooks.__harness;

const createEnv = (initial) => {
  let fileVars = initial.map((entry) => ({ ...entry }));
  const writes = [];
  let restartReason = false;
  const app = express();
  app.use(express.json());
  registerEnvRoutes({
    app,
    readEnvFile: () => fileVars.map((entry) => ({ ...entry })),
    writeEnvFile: (next) => {
      fileVars = next.map(({ key, value }) => ({ key, value }));
      writes.push(fileVars);
    },
    reloadEnv: () => true,
    kKnownVars: [{ key: "OPENAI_API_KEY", label: "OpenAI API Key", group: "ai", hint: "" }],
    kKnownKeys: new Set(["OPENAI_API_KEY"]),
    syncChannelConfig: () => {},
    isOnboarded: () => true,
    restartRequiredState: {
      markRequired: () => {
        restartReason = true;
      },
      hasReason: () => restartReason,
    },
    gatewayLaunchEnv: () => Object.fromEntries(fileVars.map(({ key, value }) => [key, value])),
    scanStaleEnvProcesses: () => ({ available: true, checkedKeys: 0, scannedProcesses: 0, unreadableProcesses: 0, stale: [] }),
  });
  return { app, writes, vars: () => fileVars };
};

const collect = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collect(node.props.children, out);
  if (node.rendered) collect(node.rendered, out);
  return out;
};
const textOf = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (node.props) textOf(node.props.children, out);
    if (node.rendered) textOf(node.rendered, out);
  }
  return out;
};
const expand = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expand);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
    try {
      out.rendered = expand(node.type(node.props || {}));
    } catch {
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) out.props = { ...out.props, children: expand(out.props.children) };
  return out;
};

const kEntry = { key: "OPENAI_API_KEY", label: "OpenAI API Key", group: "ai", source: "env_file", value: "sk-old" };
const renderRow = (props) => {
  harness.begin();
  return ProviderKeyRow({ entry: kEntry, ...props });
};
const flush = async () => {
  for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const typeAndSave = async (props, value) => {
  let tree = renderRow(props);
  collect(tree).find((node) => node.props?.id === "provider-key-OPENAI_API_KEY-replace").props.onclick();
  tree = renderRow(props);
  collect(tree).find((node) => node.type === SecretInput && node.props.id).props.onInput({ target: { value } });
  tree = renderRow(props);
  const form = collect(tree).find((node) => node.type === "form");
  await form.props.onSubmit({ preventDefault: () => {} });
  await flush();
  return renderRow(props);
};

const kModelsBase = {
  catalog: [],
  primary: "",
  configuredModels: {},
  authProfiles: [],
  authOrder: {},
  codexStatus: { connected: false },
  codexStatusError: "",
  codexStatusKnown: false,
  loading: false,
  saving: false,
  ready: true,
  error: null,
  isDirty: false,
  addModel: vi.fn(),
  removeModel: vi.fn(),
  setPrimaryModel: vi.fn(),
  editProfile: vi.fn(),
  editAuthOrder: vi.fn(),
  getProfileValue: () => null,
  getEffectiveOrder: () => [],
  cancelChanges: vi.fn(),
  saveAll: vi.fn(),
  refreshCodexStatus: vi.fn(),
};
const kCheckFixture = {
  lastRun: {
    checkedAt: "2026-11-07T17:00:00.000Z",
    results: [
      { ref: "anthropic/claude-opus-4-8", severity: "ok", reason: "Answered" },
      { ref: "openai/gpt-5.5", severity: "error", reason: "Not found", fix: "Pick gpt-5.6 instead" },
    ],
  },
  failures: [],
};
const kEnvFixture = {
  vars: [
    { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", group: "ai", source: "env_file", value: "sk-ant-x" },
    { key: "ANTHROPIC_TOKEN", label: "Anthropic Setup Token", group: "ai", source: "unset", value: "" },
    { key: "OPENAI_API_KEY", label: "OpenAI API Key", group: "ai", source: "deployment", value: "" },
    { key: "ELEVENLABS_API_KEY", label: "ElevenLabs", group: "ai", source: "unset", value: "" },
    { key: "GITHUB_TOKEN", label: "GitHub", group: "github", source: "env_file", value: "ghp" },
  ],
};
const renderModels = (props = {}) => {
  harness.begin();
  return expand(Models({ onRestartRequired: vi.fn(), ...props }));
};

beforeEach(() => {
  harness.reset();
  requests.length = 0;
  refreshed.length = 0;
  readFixtures.clear();
  vi.clearAllMocks();
});

describe("frontend/models-tab key save", () => {
  it("patchEnvVar sends exactly one PATCH /api/env with {key, value} and leaves every other key as it is", async () => {
    const env = createEnv([
      { key: "OPENAI_API_KEY", value: "sk-old" },
      { key: "CUSTOM_FLAG", value: "on" },
    ]);
    envApp = env.app;
    const result = await patchEnvVar({ key: "OPENAI_API_KEY", value: "sk-new" });
    expect(result.ok).toBe(true);
    expect(requests).toEqual([{ url: "/api/env", method: "PATCH", body: { key: "OPENAI_API_KEY", value: "sk-new" } }]);
    expect(env.vars()).toEqual([
      { key: "CUSTOM_FLAG", value: "on" },
      { key: "OPENAI_API_KEY", value: "sk-new" },
    ]);
  });

  it("Replace → type → Save key sends one PATCH, never PUT, and reports the restart to the page", async () => {
    const env = createEnv([
      { key: "OPENAI_API_KEY", value: "sk-old" },
      { key: "CUSTOM_FLAG", value: "on" },
    ]);
    envApp = env.app;
    const onSaved = vi.fn(async () => {});
    const tree = await typeAndSave({ onSaved }, "sk-mock-throwaway");
    expect(requests.map((entry) => entry.method)).toEqual(["PATCH"]);
    expect(requests[0].body).toEqual({ key: "OPENAI_API_KEY", value: "sk-mock-throwaway" });
    expect(env.vars().find((entry) => entry.key === "CUSTOM_FLAG")).toEqual({ key: "CUSTOM_FLAG", value: "on" });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.calls[0][0]).toMatchObject({ ok: true, restartRequired: true });
    expect(textOf(tree).join("").replace(/\s+/g, " ")).toContain("Saved to .env. It applies after the gateway restarts.");
  });

  it("a failed save shows the server's error under the row and keeps the typed value", async () => {
    const env = createEnv([{ key: "OPENAI_API_KEY", value: "sk-old" }]);
    envApp = env.app;
    const tree = await typeAndSave({}, "bad\nvalue");
    expect(requests).toHaveLength(1);
    const alert = collect(tree).find((node) => node.props?.role === "alert");
    expect(alert).toBeTruthy();
    expect(textOf(alert).join("").length).toBeGreaterThan(0);
    expect(collect(tree).find((node) => node.type === SecretInput && node.props.id).props.value).toBe("bad\nvalue");
  });

  it("models-tab never imports saveEnvVars and never sends PUT", () => {
    const dir = path.resolve("lib/public/js/components/models-tab");
    for (const file of readdirSync(dir)) {
      const source = readFileSync(path.join(dir, file), "utf8");
      expect(source, file).not.toMatch(/saveEnvVars/);
      expect(source, file).not.toMatch(/["']PUT["']/);
    }
  });
});

describe("frontend/models-tab key rows", () => {
  it("says where each value comes from, and a deployment value gets no Show", () => {
    expect(model.describeKeySource("env_file")).toBe("Set in .env");
    expect(model.describeKeySource("deployment")).toBe("From deployment");
    expect(model.describeKeySource("unset")).toBe("Not set");
    expect(model.getKeyRowActions({ source: "env_file" })).toEqual(["show", "replace"]);
    expect(model.getKeyRowActions({ source: "deployment" })).toEqual(["replace"]);
    expect(model.getKeyRowActions({ source: "unset" })).toEqual(["add"]);

    const deploymentRow = collect(renderRow({ entry: { ...kEntry, source: "deployment", value: "" } }));
    expect(deploymentRow.some((node) => node.type === SecretInput)).toBe(false);
    const fileRow = collect(renderRow({}));
    expect(fileRow.find((node) => node.type === SecretInput).props.readOnly).toBe(true);
  });

  it("groups ai keys by provider, other keys last, and takes the group word only from the model check", () => {
    const groups = model.buildProviderKeyGroups({ vars: kEnvFixture.vars, authProviders: ["openai-codex"] });
    expect(groups.map((group) => group.label)).toEqual(["Anthropic", "OpenAI", "Other provider keys"]);
    expect(groups[0].keys.map((entry) => entry.key)).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN"]);
    expect(groups[1].authProviders).toEqual(["openai-codex"]);
    expect(groups.every((group) => group.check === null)).toBe(true);

    const checked = model.buildProviderKeyGroups({ vars: kEnvFixture.vars, lastRun: kCheckFixture.lastRun });
    expect(checked.map((group) => group.check?.word || null)).toEqual(["Check passed", "Check failed", null]);
  });
});

describe("frontend/models-tab words", () => {
  it("headline names the default, or says there is none", () => {
    expect(model.buildModelsHeadline({ ready: true, primary: "anthropic/claude-opus-4-8", primaryLabel: "Claude Opus 4.8" })).toBe(
      "Claude Opus 4.8 is the default for this box.",
    );
    expect(model.buildModelsHeadline({ ready: true, primary: "" })).toBe("No default model yet. Add a model to start.");
    expect(model.buildModelsHeadline({ ready: false, primary: "x" })).toBe("Loading the default model…");
  });

  it("the default model gets a row even when the allowlist does not name it, so the table never contradicts the headline", () => {
    const rows = model.buildModelRows({ configuredModels: {}, primary: "mock/echo", agents: [{ id: "main", name: "main" }] });
    expect(rows.map((row) => [row.key, row.configured, row.usedBy])).toEqual([["mock/echo", false, ["Box default", "main"]]]);
    const both = model.buildModelRows({ configuredModels: { "mock/echo": {}, "a/b": {} }, primary: "mock/echo" });
    expect(both.map((row) => [row.key, row.configured])).toEqual([["mock/echo", true], ["a/b", true]]);
  });

  it("used by lists the box default and inheriting agents, then overrides", () => {
    const agents = [
      { id: "main", name: "main" },
      { id: "ops", name: "Ops", model: "anthropic/claude-opus-4-8" },
      { id: "cheap", name: "Cheap", model: { primary: "openai/gpt-5.5" } },
    ];
    expect(model.buildUsedBy({ modelKey: "anthropic/claude-opus-4-8", primary: "anthropic/claude-opus-4-8", agents })).toEqual([
      "Box default",
      "main",
      "Ops",
    ]);
    expect(model.buildUsedBy({ modelKey: "openai/gpt-5.5", primary: "anthropic/claude-opus-4-8", agents })).toEqual(["Cheap"]);
  });

  it("the check column says Not checked, Checking…, Passed or Failed with the fix", () => {
    expect(model.describeModelCheck({ lastRun: null, modelKey: "a/b" }).word).toBe("Not checked");
    expect(model.describeModelCheck({ lastRun: kCheckFixture.lastRun, modelKey: "a/b", running: true }).word).toBe("Checking…");
    expect(model.describeModelCheck({ lastRun: kCheckFixture.lastRun, modelKey: "anthropic/claude-opus-4-8" })).toEqual({
      word: "Passed",
      tone: "success",
      fix: "",
    });
    expect(model.describeModelCheck({ lastRun: kCheckFixture.lastRun, modelKey: "openai/gpt-5.5" })).toEqual({
      word: "Failed",
      tone: "danger",
      fix: "Pick gpt-5.6 instead",
    });
    expect(model.buildCheckSummary({ lastRun: null })).toBe("No check has run since AlphaClaw started.");
    expect(
      model.buildCheckSummary({ lastRun: kCheckFixture.lastRun, nowMs: Date.parse("2026-11-07T17:05:00.000Z") }),
    ).toBe("Checked 5 minutes ago: 1 passed, 1 failed.");
  });
});

describe("frontend/models-tab page", () => {
  const configured = {
    ...kModelsBase,
    primary: "anthropic/claude-opus-4-8",
    configuredModels: { "anthropic/claude-opus-4-8": {}, "openai/gpt-5.5": {} },
    authProfiles: [{ id: "anthropic:default", provider: "anthropic", type: "api_key", key: "k" }],
    codexStatus: { connected: true },
    codexStatusKnown: true,
    getProfileValue: (id) => (id === "anthropic:default" ? { key: "k" } : null),
  };

  it("shows the restart prompt after a key change", async () => {
    useModels.mockReturnValue(configured);
    readFixtures.set("/api/env", kEnvFixture);
    const onRestartRequired = vi.fn();
    const tree = renderModels({ onRestartRequired });
    const row = collect(tree).find((node) => node.type === ProviderKeyRow && node.props.entry.key === "ANTHROPIC_API_KEY");
    await row.props.onSaved({ ok: true, restartRequired: true });
    expect(onRestartRequired).toHaveBeenCalledWith(true);
    expect(refreshed).toContainEqual(["/api/env", { force: true }]);
  });

  it("never says Connected, and group words appear only with a check result", () => {
    useModels.mockReturnValue(configured);
    readFixtures.set("/api/env", kEnvFixture);
    let text = textOf(renderModels()).join(" ");
    expect(text).not.toContain("Connected");
    expect(text).not.toContain("Check passed");
    expect(text).not.toContain("Check failed");
    expect(text).toContain("Not checked");

    readFixtures.set("/api/models/check", kCheckFixture);
    const tree = renderModels();
    text = textOf(tree).join(" ");
    expect(text).not.toContain("Connected");
    const headings = collect(tree).filter((node) => node.type === ProviderKeyGroupHeading);
    const words = new Map(headings.map((node) => [node.props.group.label, node.props.group.check?.word || null]));
    expect([...words]).toEqual([
      ["Anthropic", "Check passed"],
      ["OpenAI", "Check failed"],
      ["Other provider keys", null],
    ]);
  });

  it("puts the default sentence first and Add model is the one solid button", () => {
    useModels.mockReturnValue(configured);
    readFixtures.set("/api/env", kEnvFixture);
    const tree = renderModels();
    const solid = collect(tree).filter((node) => node.type === ActionButton && node.props.tone === "solid");
    expect(solid.map((node) => node.props.idleLabel)).toEqual(["Add model"]);
    const text = textOf(tree).join(" ");
    expect(text.indexOf("is the default for this box.")).toBeGreaterThan(-1);
    expect(text.indexOf("is the default for this box.")).toBeLessThan(text.indexOf("Provider keys"));
  });
});
