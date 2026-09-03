const fs = require("fs");
const path = require("path");

const { buildSystemCronFile, isSafeCronSchedule } = require("../../lib/cli/system-cron");

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
    expect(buildSystemCronFile({ ...args, schedule: "*/15 * * * *" })).toContain(
      "*/15 * * * * root bash",
    );
  });

  // The old shape used \s separators, so a "five-field" schedule whose
  // separators were newlines injected arbitrary env/command lines into the
  // root-owned cron file. Every row here PASSED validation before the fix.
  it.each([
    ["LF separators", "*\n*\n*\n*\n*"],
    ["CR separator", "* * * *\r0"],
    ["CRLF separator", "* * *\r\n* 0"],
    ["TAB separators", "*\t*\t*\t*\t*"],
    ["env-line injection", "PATH=/tmp/evil\n*\n*\n*\n*"],
    ["MAILTO injection", "MAILTO=a@evil\n*\n*\n*\n*"],
    ["NUL in field", `${String.fromCharCode(0)} * * * *`],
    ["hash comment token", "0 * * * *#x"],
    ["equals token", "0=1 * * * *"],
    ["out-of-range minute", "99 * * * *"],
    ["zero step", "*/0 * * * *"],
    ["inverted range", "50-10 * * * *"],
    ["bare dashes", "- - - - -"],
    ["step without range", "5/2 * * * *"],
    ["overlong field", "11111111111111111 * * * *"],
    ["named day", "0 2 * * MON"],
  ])("refuses control chars / non-numeric tokens: %s", (_name, schedule) => {
    const logger = quietLogger();
    expect(buildSystemCronFile({ ...args, schedule, logger })).toBe(null);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("REFUSING"));
  });

  it("canonicalizes multi-space separators in the written line", () => {
    const content = buildSystemCronFile({ ...args, schedule: "0  *  *  *  *" });
    expect(content).toContain("0 * * * * root bash");
  });

  it.each([
    ["hourly default", "0 * * * *"],
    ["step syntax", "*/15 * * * *"],
    ["multi-space separators", "0  *  *  *  *"],
    ["ranges and lists", "0,30 8-18 * * 1-5"],
    ["trailing newline (trimmed)", "0 * * * *\n"],
  ])("still accepts legitimate schedules: %s", (_name, schedule) => {
    const content = buildSystemCronFile({ ...args, schedule });
    const canonical = String(schedule).trim().split(" ").filter(Boolean).join(" ");
    expect(content).toContain(`${canonical} root bash`);
    // Nothing but the structural line joins may carry control characters.
    expect(/[\x00-\x09\x0b-\x1f\x7f]/.test(content)).toBe(false);
  });

  describe("isSafeCronSchedule (shared guard for all three writers)", () => {
    it.each([
      ["0 * * * *", true],
      ["0  *  *  *  *", true],
      ["*/15 * * * *", true],
      ["0,30 8-18 * * 1-5", true],
      ["* * * *\r0", false],
      ["*\n*\n*\n*\n*", false],
      ["*\t*\t*\t*\t*", false],
      ["not-cron", false],
      ["* * * *", false],
      ["* * * * * *", false],
      ["@hourly", false],
      ["99 * * * *", false],
      ["*/0 * * * *", false],
      ["60 0 0 0 0", false],
      ["0 0 0 * *", false],
      ["0 23 31 12 7", true],
    ])("%s → %s", (value, expected) => {
      expect(isSafeCronSchedule(value)).toBe(expected);
    });

    it("rejects non-strings", () => {
      expect(isSafeCronSchedule(42)).toBe(false);
      expect(isSafeCronSchedule(null)).toBe(false);
      expect(isSafeCronSchedule(undefined)).toBe(false);
    });

    it("is the ONLY schedule validator — no writer keeps a private \\s-based regex", () => {
      // The injection returned once already via a drifted inline copy
      // (bin/alphaclaw.js). Pin every writer to the shared export.
      const binSource = fs.readFileSync(
        path.join(__dirname, "../../bin/alphaclaw.js"),
        "utf8",
      );
      const routesSource = fs.readFileSync(
        path.join(__dirname, "../../lib/server/routes/system.js"),
        "utf8",
      );
      for (const source of [binSource, routesSource]) {
        // Call form, not mere mention (a require line alone won't satisfy).
        expect(source).toMatch(/isSafeCronSchedule\(/);
        // Ban the drift CLASS, not one spelling: any \S/\s-based field
        // matching or whitespace-splitting near cron code is a regression.
        expect(source).not.toMatch(/\\S\+\\s/);
      }
    });
  });
});
