// LIVE TIER — AlphaClaw's two bootstrap extras against the REAL pinned
// OpenClaw's own bootstrap-size check (`openclaw doctor --lint --json`,
// finding core/doctor/bootstrap-size). With a large topic registry and
// several Google accounts, the old single merged file is over OpenClaw's
// per-file cap and the check flags it; the rules file plus the reference file
// AlphaClaw writes now are both accepted, injected and under the cap.
// When this tier fails but the hermetic suite is green, suspect upstream
// OpenClaw drift first (AGENTS.md "test:live" note).

const realFs = require("fs");
const path = require("path");
const liveHelpers = require("./live-helpers");
const { syncBootstrapPromptFiles } = require("../../lib/server/onboarding/workspace");
const { OPENCLAW_DIR, WORKSPACE_DIR, kSetupDir } = require("../../lib/server/constants");
const { kRegistryPath } = require("../../lib/server/topic-registry");

const describeLive = liveHelpers.kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 4 * 60 * 1000;

const kGroupIds = Array.from({ length: 6 }, (_, g) => "-100200300" + g);

const buildLargeRegistry = () => ({
  version: 2,
  meta: { sweepWatermark: 0 },
  groups: Object.fromEntries(
    kGroupIds.map((groupId, g) => {
      const topics = {};
      for (let t = 0; t < 60; t += 1) {
        topics[String(1000 + t)] = { name: "Project workstream " + g + "-" + t + " planning and review" };
      }
      for (let d = 0; d < 15; d += 1) {
        topics[String(5000 + d)] = { discovered: true, lastSeenAt: 1700000000000 + d };
      }
      return [groupId, { channel: "telegram", name: "Operations group " + g, topics }];
    }),
  ),
});

// AlphaClaw's real sync, rendered against a capturing fs.
const renderAlphaclawBootstrapFiles = () => {
  const templates = new Set([
    path.join(kSetupDir, "core-prompts", "TOOLS.md"),
    path.join(kSetupDir, "core-prompts", "AGENTS.md"),
  ]);
  const googleStatePath = path.join(OPENCLAW_DIR, "gogcli", "state.json");
  const config = {
    channels: { telegram: { groups: Object.fromEntries(kGroupIds.map((id) => [id, { enabled: true }])) } },
  };
  const googleState = {
    version: 2,
    accounts: Array.from({ length: 6 }, (_, i) => ({
      id: "acc" + i,
      email: "person" + i + "@example.com",
      client: "default",
      personal: true,
      authenticated: true,
      services: ["gmail:read", "calendar:read", "drive:read"],
    })),
    gmailPush: { token: "", topics: {} },
  };
  const writes = new Map();
  const fs = {
    readFileSync: (target) => {
      if (templates.has(target)) return realFs.readFileSync(target, "utf8");
      if (target === path.join(OPENCLAW_DIR, "openclaw.json")) return JSON.stringify(config);
      if (target === googleStatePath) return JSON.stringify(googleState);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    existsSync: (target) => target === googleStatePath,
    writeFileSync: (target, content) => writes.set(target, String(content)),
    mkdirSync: () => {},
  };
  const registry = JSON.stringify(buildLargeRegistry());
  const original = realFs.readFileSync;
  const spy = vi
    .spyOn(realFs, "readFileSync")
    .mockImplementation((target, ...rest) =>
      target === kRegistryPath ? registry : original.call(realFs, target, ...rest),
    );
  const quiet = ["log", "warn", "error"].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
  try {
    syncBootstrapPromptFiles({ fs, workspaceDir: WORKSPACE_DIR, baseUrl: "https://setup.example.com" });
  } finally {
    spy.mockRestore();
    for (const mock of quiet) mock.mockRestore();
  }
  return {
    rules: writes.get(path.join(WORKSPACE_DIR, "hooks", "bootstrap", "AGENTS.md")),
    reference: writes.get(path.join(WORKSPACE_DIR, "hooks", "bootstrap", "reference", "AGENTS.md")),
  };
};

// A throwaway OpenClaw state with one workspace and the given extras.
const lintBootstrap = (files) => {
  const root = liveHelpers.mkTemp("alphaclaw-live-bootstrap-");
  const stateDir = path.join(root, ".openclaw");
  const workspace = path.join(root, "workspace");
  realFs.mkdirSync(stateDir, { recursive: true });
  realFs.mkdirSync(workspace, { recursive: true });
  realFs.writeFileSync(path.join(workspace, "AGENTS.md"), "# Workspace\n");
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(workspace, ...relativePath.split("/"));
    realFs.mkdirSync(path.dirname(target), { recursive: true });
    realFs.writeFileSync(target, content);
  }
  realFs.writeFileSync(
    path.join(stateDir, "openclaw.json"),
    JSON.stringify({
      agents: { defaults: { workspace } },
      hooks: {
        internal: {
          enabled: true,
          entries: { "bootstrap-extra-files": { enabled: true, paths: Object.keys(files) } },
        },
      },
    }),
  );
  const payload = liveHelpers.runCliJson(liveHelpers.repoOpenclawBin(), ["doctor", "--lint", "--json"], {
    env: { ...liveHelpers.scrubTestRunnerEnv(), OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: root },
    exits: [0, 1],
  });
  return (payload.findings || [])
    .filter((finding) => finding.checkId === "core/doctor/bootstrap-size")
    .map((finding) => path.relative(workspace, finding.path));
};

describeLive("bootstrap extras vs OpenClaw's per-file cap (live)", () => {
  it(
    "the old merged file is flagged; the rules and reference files are not",
    () => {
      const { rules, reference } = renderAlphaclawBootstrapFiles();
      expect(rules).toBeTruthy();
      expect(reference).toBeTruthy();

      expect(lintBootstrap({ "hooks/bootstrap/AGENTS.md": rules + reference })).toEqual([
        "hooks/bootstrap/AGENTS.md",
      ]);
      expect(
        lintBootstrap({
          "hooks/bootstrap/AGENTS.md": rules,
          "hooks/bootstrap/reference/AGENTS.md": reference,
        }),
      ).toEqual([]);
      // OpenClaw loads the reference path as its own extra, under its own cap.
      expect(
        lintBootstrap({
          "hooks/bootstrap/AGENTS.md": rules,
          "hooks/bootstrap/reference/AGENTS.md": reference + "| g | t | 1 |\n".repeat(400),
        }),
      ).toEqual(["hooks/bootstrap/reference/AGENTS.md"]);
    },
    kTestTimeoutMs,
  );
});
