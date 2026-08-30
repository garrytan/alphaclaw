const { buildDoctorPrompt } = require("../../lib/server/doctor/prompt");
const {
  kBeta81Profile,
  kStableProfile,
} = require("../../lib/server/doctor/context-profiles");

describe("server/doctor-prompt", () => {
  it("includes OpenClaw default-template context for AGENTS.md", () => {
    const prompt = buildDoctorPrompt({
      workspaceRoot: "/tmp/workspace",
      managedRoot: "/tmp/managed",
    });

    expect(prompt).toContain("OpenClaw default context:");
    expect(prompt).toContain("`AGENTS.md` is the workspace home file in the default OpenClaw template.");
    expect(prompt).toContain("Do not treat default-template content as drift just because it is broad or multi-purpose.");
  });

  it("states the corrected, profile-derived injection contract", () => {
    const prompt = buildDoctorPrompt({
      workspaceRoot: "/tmp/workspace",
      managedRoot: "/tmp/managed",
      profile: kStableProfile,
      installedVersion: "2026.7.1-2",
      releaseChannel: "stable",
    });

    expect(prompt).toContain("Installed OpenClaw: 2026.7.1-2 (channel: stable; context profile: stable-2026.7)");
    expect(prompt).toContain("20000 chars per file and 60000 chars total");
    expect(prompt).toContain("spent in injection order");
    expect(prompt).toContain("skipped entirely");
    expect(prompt).toContain("first 75% and last 25%");
    expect(prompt).toContain("`BOOTSTRAP.md` is injected only until workspace setup completes");
    // The old myth must never reappear.
    expect(prompt).not.toContain("first 70%");
    expect(prompt).not.toContain("without a warning");
    expect(prompt).not.toContain("150000");
  });

  it("keeps beta-only session-scope advice off the stable prompt", () => {
    // Group/channel MEMORY.md stripping does not exist on the pinned stable
    // (filterBootstrapFilesForSession filters subagent/cron keys only) —
    // giving stable installs that placement advice would be wrong.
    const stablePrompt = buildDoctorPrompt({
      workspaceRoot: "/tmp/workspace",
      managedRoot: "/tmp/managed",
      profile: kStableProfile,
    });
    expect(stablePrompt).not.toContain(
      "Group and channel sessions never receive the root MEMORY.md.",
    );
    expect(stablePrompt).toContain(
      "Session scope: Sub-agent sessions inject only AGENTS.md and TOOLS.md.",
    );

    const betaPrompt = buildDoctorPrompt({
      workspaceRoot: "/tmp/workspace",
      managedRoot: "/tmp/managed",
      profile: kBeta81Profile,
    });
    expect(betaPrompt).toContain(
      "Session scope: Group and channel sessions never receive the root MEMORY.md.",
    );
  });

  it("states beta-only facts on the beta profile", () => {
    const prompt = buildDoctorPrompt({
      workspaceRoot: "/tmp/workspace",
      managedRoot: "/tmp/managed",
      profile: kBeta81Profile,
      installedVersion: "2026.8.1-beta.3",
      releaseChannel: "beta",
    });

    expect(prompt).toContain("context profile: beta-2026.8.1");
    expect(prompt).toContain("`USER.md` has a fixed 4000-char cap");
    expect(prompt).toContain("RETIRED on this version");
    expect(prompt).toContain("`TOOLS.md`");
    expect(prompt).toContain("Sub-agent sessions inject only AGENTS.md");
  });

  it("includes the memory and placement doctrine review priorities", () => {
    const prompt = buildDoctorPrompt({
      workspaceRoot: "/tmp/workspace",
      managedRoot: "/tmp/managed",
    });

    expect(prompt).toContain("Placement doctrine");
    expect(prompt).toContain("`SOUL.md` is voice, stance, and personality");
    expect(prompt).toContain("`MEMORY.md` is curated long-term memory");
    expect(prompt).toContain("legacy repair input only");
    expect(prompt).toContain("Memory hygiene: stale or contradictory memories");
    expect(prompt).toContain("Skill descriptions in `skills/*/SKILL.md`");
  });

  it("enumerates the allowed card categories", () => {
    const prompt = buildDoctorPrompt({
      workspaceRoot: "/tmp/workspace",
      managedRoot: "/tmp/managed",
    });
    expect(prompt).toContain('Use one of these categories for each card:');
    expect(prompt).toContain('"project context"');
    expect(prompt).toContain('"memory hygiene"');
    expect(prompt).toContain('"skills"');
  });

  it("tells the analyzer not to propose structural changes to AlphaClaw-managed files", () => {
    const prompt = buildDoctorPrompt({
      workspaceRoot: "/tmp/workspace",
      managedRoot: "/tmp/managed",
      lockedPaths: ["hooks/bootstrap/AGENTS.md"],
    });

    expect(prompt).toContain("AlphaClaw ownership rules:");
    expect(prompt).toContain(
      "Do not recommend splitting, renaming, relocating, or otherwise restructuring AlphaClaw-managed files solely for cleanliness or purity.",
    );
    expect(prompt).toContain(
      "Do not create cards whose primary recommendation is to refactor AlphaClaw-managed file structure",
    );
  });

  it("frames dismissed findings as suppressed and fixed findings as context only", () => {
    const prompt = buildDoctorPrompt({
      workspaceRoot: "/tmp/workspace",
      managedRoot: "/tmp/managed",
      resolvedCards: [
        { status: "dismissed", title: "Cleanup docs", category: "workspace" },
        { status: "fixed", title: "Stale docs remain", category: "workspace" },
      ],
    });

    expect(prompt).toContain("Previously dismissed findings");
    expect(prompt).toContain("[dismissed] Cleanup docs (workspace)");
    expect(prompt).toContain("Previous findings marked as fixed");
    expect(prompt).not.toContain("Previou findings");
    expect(prompt).toContain("[fixed] Stale docs remain (workspace)");
    expect(prompt).toContain(
      'Do not re-suggest findings that appear in the "Previously dismissed" list above',
    );
    expect(prompt).toContain(
      "Previously fixed findings may be re-suggested if the underlying issue is still present",
    );
  });

  it("stamps the doctor-v2 prompt version by default", () => {
    const prompt = buildDoctorPrompt({
      workspaceRoot: "/tmp/workspace",
      managedRoot: "/tmp/managed",
    });
    expect(prompt).toContain("promptVersion: doctor-v2");
  });
});
