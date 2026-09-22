const { assessBackupPreflight, upstreamBackupVeto } = require("../../lib/server/openclaw-backup-preflight");
const { kDefaultBackupBudget } = require("../../lib/server/openclaw-backup-ladder");

const diagnosis = (extra = {}) => ({ walk: "complete", copySetBytes: 1024, tarSetBytes: 1024,
  directories: { measurementComplete: true, entries: 100_000, selectedEntries: 50_000, envFiles: [], absoluteSymlinks: [] }, ...extra });

describe("backup preflight admission", () => {
  it("admits complete scratch-heavy trees when the selected copy fits", () => {
    expect(assessBackupPreflight(diagnosis(), kDefaultBackupBudget)).toEqual({ blocked: false, reason: null });
  });
  it("refuses incomplete measurement without claiming that it paused the gateway", () => {
    const verdict = assessBackupPreflight(diagnosis({ walk: "incomplete", walkError: "scan timed out" }), kDefaultBackupBudget);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain("scan timed out");
    expect(verdict.reason).toContain("has not been paused");
  });
  it("reports full counts and refuses a genuinely oversized selected tree", () => {
    const input = diagnosis();
    input.directories.entries = 400_000;
    input.directories.selectedEntries = 350_000;
    const verdict = assessBackupPreflight(input, kDefaultBackupBudget);
    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain("350000 selected entries (400000 total)");
  });
  it("rejects selected bytes that cannot fit the copy's byte budget", () => {
    expect(assessBackupPreflight(diagnosis({ copySetBytes: 20_000_000_000 }), kDefaultBackupBudget).blocked).toBe(true);
  });
  it("refuses oversized manifest membership before copying file payloads", () => {
    expect(assessBackupPreflight(diagnosis({ minimumManifestBytes: 40 * 1024 ** 2 }), kDefaultBackupBudget).blocked).toBe(true);
  });
  it.each(["enumerate", "budget"])("never retries upstream after offline %s failure", (stage) => {
    expect(upstreamBackupVeto(diagnosis(), { stage }, kDefaultBackupBudget)).toBe("offline_copy_budget");
  });
  it("vetoes upstream when a .env file would ride into the upstream archive", () => {
    const input = diagnosis();
    input.directories.envFiles = [".env"];
    expect(upstreamBackupVeto(input, null, kDefaultBackupBudget)).toBe("env_files_excluded");
  });
  it("absolute-target symlinks are reported, never a veto — OpenClaw plants them in every state dir (plugin-skills/*) and its backup skips them (v0.9.89 regression, live tier 2026-09-22)", () => {
    const input = diagnosis();
    input.directories.absoluteSymlinks = [
      { path: "plugin-skills/browser-automation", target: "/app/node_modules/openclaw/dist/extensions/browser/skills/browser-automation" },
      { path: "wiki/link", target: "/outside" },
    ];
    expect(upstreamBackupVeto(input, null, kDefaultBackupBudget)).toBeNull();
    expect(assessBackupPreflight(input, kDefaultBackupBudget).blocked).toBe(false);
  });
  it("vetoes raw upstream bytes even when the excluded copy fits", () => {
    expect(upstreamBackupVeto(diagnosis({ tarSetBytes: 3 * 1024 ** 3 }), null, kDefaultBackupBudget)).toBe("upstream_byte_budget");
  });
  it("vetoes a raw upstream tree exceeding the entry budget even when the selected copy fits", () => {
    const input = diagnosis();
    input.directories.entries = 250_000;
    expect(upstreamBackupVeto(input, null, kDefaultBackupBudget)).toBe("upstream_entry_budget");
    expect(assessBackupPreflight(input, kDefaultBackupBudget).blocked).toBe(false);
  });
});
