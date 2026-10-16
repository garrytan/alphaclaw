const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  describeCaptureCause,
  describeDoctorFailure,
  describeManualFix,
  describePreflightRule,
} = require("../../lib/server/doctor-plain-language");
const { createDoctorTranscript, readDoctorTranscript, kDoctorTranscriptFileName } = require("../../lib/server/doctor-transcript");

describe("doctor-plain-language", () => {
  it.each([
    ["Original state capture was unavailable: SQLite staging ancestor must not allow another user to replace its child: /data", "ancestor_replaceable", "/data"],
    ["SQLite staging ancestor must be a real directory: /mnt/x", "not_directory", "/mnt/x"],
    ["Private SQLite staging root must be owned by the current user and not writable by other users: /data/s.update-captures", "capture_root_unsafe", "/data/s.update-captures"],
    ["needs 120 MiB near /data, but only 30 MiB is available", "space", "/data"],
  ])("knows %j", (cause, rule, failingPath) => {
    expect(describeCaptureCause(cause)).toMatchObject({ rule, path: failingPath });
  });

  it("never turns unknown upstream text into the headline", () => {
    expect(describeCaptureCause("weird new failure <script>")).toEqual({
      rule: null,
      path: null,
      sentence: "OpenClaw couldn't take a snapshot for a reason AlphaClaw doesn't recognize.",
    });
    expect(describeDoctorFailure({ reason: "exit_3" })).toBe("OpenClaw's data upgrade stopped with an error it didn't explain.");
  });

  it("names the failing check and the bridge release", () => {
    expect(describeDoctorFailure({ reason: "failing_check", detail: "Failing check auth-store: unreadable" })).toBe("One of OpenClaw's upgrade checks failed: auth-store.");
    expect(describeDoctorFailure({ reason: "upgrade_window_refused", bridgeVersion: "2026.9.5" })).toMatch(/OpenClaw 2026\.9\.5 still can/);
  });

  it("preflight rules and manual fixes", () => {
    expect(describePreflightRule({ failingRule: "space", failingPath: "/data", freeBytes: 1, neededBytes: 2, formatBytes: (n) => `${n}B` })).toBe("A snapshot needs 2B free near /data, and 1B is free.");
    expect(describeManualFix({ failingPath: "/data", fixable: { reason: "not_owner" } })).toBe("Run chmod +t /data as root on the host (AlphaClaw's user doesn't own it).");
  });
});

describe("doctor-transcript", () => {
  it("writes the run's output redacted, bounded and private, with header and footer", () => {
    const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-"));
    const transcript = createDoctorTranscript({ managedDir, header: "doctor --fix — source retry", secrets: ["s3cr3t-value-123"], maxBytes: 8192, logger: { warn: () => {} } });
    transcript.onOutput("token s3cr3t-value-123 here\n", "stdout");
    for (let i = 0; i < 200; i += 1) transcript.onOutput(`line ${i} ${"x".repeat(20)}\n`, i % 2 ? "stderr" : "stdout");
    transcript.onOutput(`${"y".repeat(10_000)}\n`, "stdout");
    transcript.flush({ footer: "[finished]" });
    const file = path.join(managedDir, kDoctorTranscriptFileName);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const read = readDoctorTranscript({ managedDir });
    expect(read.text).not.toContain("s3cr3t-value-123");
    expect(read.text.length).toBeLessThanOrEqual(8192 + 300);
    expect(read.text).toContain("earlier line(s) dropped");
    // One overlong line is clamped, never kept whole.
    expect(read.text).not.toContain("y".repeat(4097));
    expect(read.text).toContain("doctor --fix — source retry");
    expect(read.text.trimEnd().endsWith("[finished]")).toBe(true);
    expect(read.text).toContain("line 199");
    expect(read.text).not.toContain("line 0 ");
  });
});
