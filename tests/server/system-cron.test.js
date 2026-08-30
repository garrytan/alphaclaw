const { buildSystemCronFile } = require("../../lib/cli/system-cron");

const quietLogger = () => ({ error: vi.fn(), warn: vi.fn(), log: vi.fn() });

// The single builder behind all three /etc/cron.d/openclaw-hourly-sync
// writers (issue #25): cron applies no environment beyond what the file
// declares, so the env lines here are what keeps the hourly sync from
// resolving a phantom ~/.alphaclaw install — and any `openclaw` child from
// building a divergent ~/.openclaw state db.
describe("cli/system-cron buildSystemCronFile", () => {
  const args = {
    schedule: "0 * * * *",
    scriptPath: "/data/.openclaw/.alphaclaw/hourly-git-sync.sh",
    rootDir: "/data",
    openclawDir: "/data/.openclaw",
  };

  it("emits SHELL, PATH, the state env lines, the schedule line, and a trailing newline", () => {
    const content = buildSystemCronFile(args);
    expect(content).toBe(
      [
        "SHELL=/bin/bash",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "ALPHACLAW_ROOT_DIR=/data",
        "OPENCLAW_HOME=/data",
        "OPENCLAW_STATE_DIR=/data/.openclaw",
        "OPENCLAW_CONFIG_PATH=/data/.openclaw/openclaw.json",
        '0 * * * * root bash "/data/.openclaw/.alphaclaw/hourly-git-sync.sh" >> /var/log/openclaw-hourly-sync.log 2>&1',
        "",
      ].join("\n"),
    );
    // /etc/cron.d files without a trailing newline are ignored by cron.
    expect(content.endsWith("\n")).toBe(true);
  });

  it.each([
    ["scriptPath with spaces", { scriptPath: "/data/my dir/sync.sh" }],
    ["scriptPath with %", { scriptPath: "/data/%p/sync.sh" }],
    ["rootDir with a newline", { rootDir: "/data\nMAILTO=evil" }],
    ["rootDir with a quote", { rootDir: '/data"' }],
    ["relative openclawDir", { openclawDir: "relative/.openclaw" }],
    ["openclawDir with #", { openclawDir: "/data/#x" }],
  ])(
    "refuses (returns null, logs loudly) on unsafe paths: %s",
    (_name, overrides) => {
      const logger = quietLogger();
      expect(buildSystemCronFile({ ...args, ...overrides, logger })).toBe(null);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("REFUSING"),
      );
    },
  );

  it("refuses a malformed schedule", () => {
    const logger = quietLogger();
    expect(
      buildSystemCronFile({ ...args, schedule: "whenever; rm -rf /", logger }),
    ).toBe(null);
    // A five-field schedule of odd tokens is cron's problem, not an injection
    // vector — the command line is fixed; only field COUNT is enforced here.
    expect(buildSystemCronFile({ ...args, schedule: "*/15 * * * *" })).toContain(
      "*/15 * * * * root bash",
    );
  });
});
