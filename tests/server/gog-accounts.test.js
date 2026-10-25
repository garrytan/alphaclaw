const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCommands } = require("../../lib/server/commands");
const {
  kMaxDetectedGogAccounts,
  parseGogAuthList,
  refreshDetectedGogAccounts,
  getDetectedGogAccounts,
  resetDetectedGogAccountsForTests,
} = require("../../lib/server/gog-accounts");

const { execFileCmd } = createCommands({ gatewayEnv: () => ({}) });

describe("server/gog-accounts", () => {
  let scratchDir;
  let logSpy;

  const writeFakeGog = (body) => {
    const binPath = path.join(scratchDir, "gog");
    fs.writeFileSync(
      binPath,
      [
        `#!${process.execPath}`,
        'const fs = require("fs");',
        "fs.writeFileSync(",
        `  ${JSON.stringify(path.join(scratchDir, "capture.json"))},`,
        "  JSON.stringify({",
        "    argv: process.argv.slice(2),",
        "    xdgConfigHome: process.env.XDG_CONFIG_HOME,",
        "    keyringPassword: process.env.GOG_KEYRING_PASSWORD,",
        "  }),",
        ");",
        body,
      ].join("\n"),
      { mode: 0o755 },
    );
    return binPath;
  };
  const readCapture = () =>
    JSON.parse(fs.readFileSync(path.join(scratchDir, "capture.json"), "utf8"));
  const refresh = (gogBin, extra = {}) =>
    refreshDetectedGogAccounts({
      execFileCmd,
      gogBin,
      openclawDir: path.join(scratchDir, "openclaw"),
      keyringPassword: "test-keyring-pass",
      ...extra,
    });
  const kListing = JSON.stringify({
    accounts: [
      { email: "you@example.com", client: "default", created_at: "2026-01-01T00:00:00Z", auth: "oauth" },
      { email: "ops@example.com", client: "work", auth: "oauth" },
    ],
  });

  beforeEach(() => {
    resetDetectedGogAccountsForTests();
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "gog-accounts-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("lists what gog lists, with the env AlphaClaw gives gog", async () => {
    const gogBin = writeFakeGog(`process.stdout.write(${JSON.stringify(kListing)});`);

    expect(await refresh(gogBin)).toBe(true);

    expect(getDetectedGogAccounts()).toEqual([
      { email: "you@example.com", client: "default" },
      { email: "ops@example.com", client: "work" },
    ]);
    expect(readCapture()).toEqual({
      argv: ["auth", "list", "--json", "--no-input"],
      xdgConfigHome: path.join(scratchDir, "openclaw"),
      keyringPassword: "test-keyring-pass",
    });
    expect(await refresh(gogBin)).toBe(false);
  });

  it("fails open to no accounts when gog exits non-zero, and never logs its output", async () => {
    await refresh(writeFakeGog(`process.stdout.write(${JSON.stringify(kListing)});`));
    const gogBin = writeFakeGog(
      'process.stderr.write("read token for you@example.com: secret-ish-detail"); process.exit(1);',
    );

    expect(await refresh(gogBin)).toBe(true);

    expect(getDetectedGogAccounts()).toEqual([]);
    const logged = logSpy.mock.calls.flat().join("\n");
    expect(logged).toContain("gog account detection skipped: exit 1");
    expect(logged).not.toContain("secret-ish-detail");
  });

  it("fails open when gog is missing, hangs or prints something else", async () => {
    await refresh(path.join(scratchDir, "missing-gog"));
    expect(getDetectedGogAccounts()).toEqual([]);

    await refresh(writeFakeGog("setTimeout(() => {}, 10000);"), { timeoutMs: 300 });
    expect(getDetectedGogAccounts()).toEqual([]);

    await refresh(writeFakeGog('process.stdout.write("Not JSON");'));
    expect(getDetectedGogAccounts()).toEqual([]);

    const logged = logSpy.mock.calls.flat().join("\n");
    expect(logged).toContain("skipped: gog is not installed");
    expect(logged).toContain("skipped: timed out");
    expect(logged).toContain("skipped: unparseable output");
  });

  it("keeps the newest refresh when an older one finishes later", async () => {
    let releaseSlow;
    const slow = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    const execFileCmdMock = vi
      .fn()
      .mockImplementationOnce(() => slow)
      .mockImplementationOnce(async () => JSON.stringify({ accounts: [] }));

    const older = refreshDetectedGogAccounts({ execFileCmd: execFileCmdMock });
    const newer = refreshDetectedGogAccounts({ execFileCmd: execFileCmdMock });
    await newer;
    releaseSlow(kListing);

    expect(await older).toBe(false);
    expect(getDetectedGogAccounts()).toEqual([]);
  });

  it("drops entries that are not a plain email and client, dedupes and caps the list", () => {
    const many = Array.from({ length: kMaxDetectedGogAccounts + 5 }, (_, index) => ({
      email: `user${index}@example.com`,
    }));
    const accounts = parseGogAuthList(
      JSON.stringify({
        accounts: [
          { email: "you@example.com" },
          { email: "YOU@example.com", client: "default" },
          { email: "two words@example.com" },
          { email: "`inject`@example.com" },
          { email: "no-at-sign" },
          { email: "ok@example.com", client: "bad client" },
          ...many,
        ],
      }),
    );

    expect(accounts[0]).toEqual({ email: "you@example.com", client: "default" });
    expect(accounts).toHaveLength(kMaxDetectedGogAccounts);
    expect(accounts.map((account) => account.email)).not.toContain("ok@example.com");
  });
});
