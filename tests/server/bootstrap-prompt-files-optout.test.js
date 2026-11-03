const realFs = require("fs");
const path = require("path");
const {
  enableBootstrapReference,
  syncBootstrapPromptFiles,
} = require("../../lib/server/onboarding/workspace");
const { OPENCLAW_DIR, WORKSPACE_DIR, kSetupDir } = require("../../lib/server/constants");
const { kRegistryPath } = require("../../lib/server/topic-registry");
const watchdogDb = require("../../lib/server/db/watchdog");

// ALPH-58 decision 3: an operator who removes AlphaClaw's reference bootstrap
// path keeps it removed (an explicit alphaclaw.json flag, never the absence
// alone); the rules path always comes back, with one event and a stamp.
const kCorePromptsDir = path.join(kSetupDir, "core-prompts");
const kConfigPath = path.join(OPENCLAW_DIR, "openclaw.json");
const kAlphaclawConfigPath = path.join(OPENCLAW_DIR, "alphaclaw.json");
const kReferenceFile = path.join(WORKSPACE_DIR, "hooks", "bootstrap", "reference", "AGENTS.md");
const kRules = "hooks/bootstrap/AGENTS.md";
const kReference = "hooks/bootstrap/reference/AGENTS.md";

// In-memory fs: state survives across syncs, so a test can sync twice.
const makeVfs = (files = {}) => {
  const store = new Map(Object.entries(files));
  const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return {
    store,
    readFileSync: vi.fn((target) => {
      if (String(target).startsWith(kCorePromptsDir)) return realFs.readFileSync(target, "utf8");
      if (store.has(target)) return store.get(target);
      throw enoent();
    }),
    writeFileSync: vi.fn((target, content) => store.set(target, String(content))),
    existsSync: vi.fn((target) => store.has(target)),
    lstatSync: vi.fn((target) => {
      if (!store.has(target)) throw enoent();
      return { isFile: () => true, isSymbolicLink: () => false };
    }),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn((target) => store.delete(target)),
  };
};

const configWith = ({ hooksEnabled = true, entry } = {}) =>
  JSON.stringify({
    hooks: {
      internal: {
        enabled: hooksEnabled,
        entries: entry === undefined ? {} : { "bootstrap-extra-files": entry },
      },
    },
  });

const readConfig = (vfs) => JSON.parse(vfs.store.get(kConfigPath));
const entryPaths = (vfs) => readConfig(vfs).hooks.internal.entries["bootstrap-extra-files"].paths;
const promptFiles = (vfs) =>
  vfs.store.has(kAlphaclawConfigPath)
    ? JSON.parse(vfs.store.get(kAlphaclawConfigPath)).promptFiles
    : undefined;
const sync = (vfs, extra = {}) =>
  syncBootstrapPromptFiles({ fs: vfs, workspaceDir: WORKSPACE_DIR, baseUrl: "https://setup.example.com", ...extra });

describe("bootstrap extras: operator opt-out of the reference file (ALPH-58 decision 3)", () => {
  let events;
  beforeEach(() => {
    const original = realFs.readFileSync;
    vi.spyOn(realFs, "readFileSync").mockImplementation((target, ...rest) => {
      if (target === kRegistryPath) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return original.call(realFs, target, ...rest);
    });
    events = vi.spyOn(watchdogDb, "insertWatchdogEvent").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a first install still writes both paths and records nothing", () => {
    const vfs = makeVfs({ [kConfigPath]: "{}" });
    sync(vfs);
    expect(entryPaths(vfs)).toEqual([kRules, kReference]);
    expect(promptFiles(vfs)).toBeUndefined();
    expect(vfs.store.has(kReferenceFile)).toBe(true);
    expect(events).not.toHaveBeenCalled();
  });

  it("a rules-only entry written by an AlphaClaw older than the reference file gets both paths", () => {
    const vfs = makeVfs({
      [kConfigPath]: configWith({ entry: { enabled: true, paths: [kRules] } }),
    });
    sync(vfs);
    expect(entryPaths(vfs)).toEqual([kRules, kReference]);
    expect(promptFiles(vfs)).toBeUndefined();
  });

  it("respects a deliberate removal, persists the flag once and logs one event (upgrade seed)", () => {
    const vfs = makeVfs({
      [kConfigPath]: configWith({ entry: { enabled: true, paths: [kRules, "notes/USER.md"] } }),
      [kReferenceFile]: "stale reference from an earlier sync",
    });
    const before = vfs.store.get(kConfigPath);
    sync(vfs);
    expect(vfs.store.get(kConfigPath)).toBe(before);
    expect(promptFiles(vfs)).toEqual({
      reference: { enabled: false, detectedAt: expect.any(Number), by: "operator-config" },
    });
    expect(events).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "bootstrap_sync", source: "reference-off", status: "ok" }),
    );
    // The file itself is still written (read on demand, and by the topic CLI's
    // pointer); only the injection is off.
    expect(vfs.store.get(kReferenceFile)).toContain("# AlphaClaw Workspace Reference");

    const { detectedAt } = promptFiles(vfs).reference;
    sync(vfs);
    expect(vfs.store.get(kConfigPath)).toBe(before);
    expect(promptFiles(vfs).reference.detectedAt).toBe(detectedAt);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it("reads the flag on later syncs: a wiped entry or disabled hooks come back with the rules path only", () => {
    const flag = JSON.stringify({ promptFiles: { reference: { enabled: false, detectedAt: 1, by: "operator-config" } } });
    for (const config of [
      configWith({}),
      configWith({ hooksEnabled: false, entry: { enabled: true, paths: [kRules] } }),
      configWith({ entry: { enabled: false, paths: [kRules] } }),
    ]) {
      const vfs = makeVfs({ [kConfigPath]: config, [kAlphaclawConfigPath]: flag, [kReferenceFile]: "x" });
      sync(vfs);
      expect(readConfig(vfs).hooks.internal.enabled).toBe(true);
      expect(readConfig(vfs).hooks.internal.entries["bootstrap-extra-files"]).toMatchObject({
        enabled: true,
        paths: [kRules],
      });
      expect(promptFiles(vfs).reference.enabled).toBe(false);
    }
  });

  it("never counts a wiped entry or disabled hooks as a removal: both paths are repaired as before", () => {
    for (const config of [
      configWith({}),
      configWith({ hooksEnabled: false, entry: { enabled: true, paths: [kRules] } }),
      configWith({ entry: { enabled: false, paths: [kRules] } }),
      JSON.stringify({ gateway: { port: 18789 } }),
    ]) {
      const vfs = makeVfs({ [kConfigPath]: config, [kReferenceFile]: "x" });
      sync(vfs);
      expect(entryPaths(vfs)).toEqual([kRules, kReference]);
      expect(promptFiles(vfs)).toBeUndefined();
    }
    expect(events).not.toHaveBeenCalled();
  });

  it("an onboard rewrite (managed shell lists both paths) clears the flag and injects both again", () => {
    const vfs = makeVfs({
      [kConfigPath]: configWith({ entry: { enabled: true, paths: [kRules, kReference] } }),
      [kAlphaclawConfigPath]: JSON.stringify({
        features: { agentAdmin: { enabled: true } },
        promptFiles: { reference: { enabled: false, detectedAt: 1, by: "operator-config" } },
      }),
      [kReferenceFile]: "x",
    });
    sync(vfs);
    expect(entryPaths(vfs)).toEqual([kRules, kReference]);
    expect(promptFiles(vfs)).toBeUndefined();
    expect(JSON.parse(vfs.store.get(kAlphaclawConfigPath)).features.agentAdmin.enabled).toBe(true);
  });

  it("always restores a removed rules path, with one warning event and a rulesRestoredAt stamp", () => {
    const vfs = makeVfs({
      [kConfigPath]: configWith({ entry: { enabled: true, paths: [kReference, "notes/USER.md"] } }),
      [kReferenceFile]: "x",
    });
    sync(vfs);
    expect(entryPaths(vfs)).toEqual([kRules, kReference, "notes/USER.md"]);
    expect(promptFiles(vfs)).toEqual({ rulesRestoredAt: expect.any(Number) });
    expect(events).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "bootstrap_sync", source: "rules-restored", status: "warning" }),
    );
    sync(vfs);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it("restores the rules path even while the reference file is opted out", () => {
    const vfs = makeVfs({
      [kConfigPath]: configWith({ entry: { enabled: true, paths: ["notes/USER.md"] } }),
      [kAlphaclawConfigPath]: JSON.stringify({
        promptFiles: { reference: { enabled: false, detectedAt: 1, by: "operator-config" } },
      }),
      [kReferenceFile]: "x",
    });
    sync(vfs);
    expect(entryPaths(vfs)).toEqual([kRules, "notes/USER.md"]);
    expect(promptFiles(vfs)).toMatchObject({ reference: { enabled: false }, rulesRestoredAt: expect.any(Number) });
  });

  it("re-enables through enableBootstrapReference, and the next sync does not opt out again", () => {
    const vfs = makeVfs({
      [kConfigPath]: configWith({ entry: { enabled: true, paths: [kRules, "notes/USER.md"] } }),
      [kReferenceFile]: "x",
    });
    sync(vfs);
    expect(promptFiles(vfs).reference.enabled).toBe(false);

    expect(enableBootstrapReference({ fs: vfs })).toMatchObject({ referenceDisabled: false });
    expect(entryPaths(vfs)).toEqual([kRules, kReference, "notes/USER.md"]);
    expect(promptFiles(vfs)).toBeUndefined();
    expect(events).toHaveBeenLastCalledWith(expect.objectContaining({ source: "reference-on" }));

    sync(vfs);
    expect(entryPaths(vfs)).toEqual([kRules, kReference, "notes/USER.md"]);
    expect(promptFiles(vfs)).toBeUndefined();
  });

  it("never overwrites a damaged alphaclaw.json to record the flag", () => {
    const onFailure = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const vfs = makeVfs({
      [kConfigPath]: configWith({ entry: { enabled: true, paths: [kRules] } }),
      [kAlphaclawConfigPath]: "{ not json",
      [kReferenceFile]: "x",
    });
    sync(vfs, { onFailure });
    expect(vfs.store.get(kAlphaclawConfigPath)).toBe("{ not json");
    expect(entryPaths(vfs)).toEqual([kRules]);
    expect(onFailure).toHaveBeenCalledWith("prompt-files-flag", expect.any(Error));
  });
});
