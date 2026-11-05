const { execFileSync } = require("child_process");
const { createRequire } = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  formatEnvValue,
  decodeEnvValue,
  parseEnvLine,
  parseEnvFileContent,
  findUnwritableEnvValue,
} = require("../../lib/server/utils/env-file-format");
const { parseEnvFileText } = require("../../lib/server/sidecars/env");

// The dotenv OpenClaw itself resolves: its global and workspace .env loaders
// call this package's parse on <state>/.env, a symlink to AlphaClaw's .env.
const { parse: openclawDotenvParse } = createRequire(
  path.resolve(__dirname, "../../node_modules/openclaw/package.json"),
)("dotenv");

const envModulePath = "../../lib/server/env";
const constantsModulePath = "../../lib/server/constants";
const loadEnvModule = (rootDir) => {
  vi.resetModules();
  delete require.cache[require.resolve(envModulePath)];
  delete require.cache[require.resolve(constantsModulePath)];
  process.env.ALPHACLAW_ROOT_DIR = rootDir;
  return require(envModulePath);
};

const kBacktick = "\u0060";

// Values that break a bare KEY=value line for bash, dotenv or both. Every one
// must come back byte for byte from every reader.
const kNastyValues = {
  SPACES: "two words  and more",
  WRITER_CMD: "alphaclaw git-writer -- <paths>",
  DOLLAR: "$HOME and $\{PATH}",
  BACKTICKS: kBacktick + "id" + kBacktick + " and $(id)",
  DOUBLE_QUOTES: 'say "hi"',
  SINGLE_QUOTE: "it's",
  LITERAL_SINGLE_QUOTED: "'x'",
  LITERAL_DOUBLE_QUOTED: '"x"',
  HASH: "a#b",
  SPACE_HASH: "a #b",
  LEADING_HASH: "#not-a-comment",
  EQUALS: "k=v=w",
  BACKSLASH: "back\\slash \\n not a newline",
  SHELL_OPS: "a;b&c|d>e<f*g?h[i]{j}~k!l",
  TILDE: "~/path",
  LEADING_SPACES: "   lead",
  UNICODE: "ünïcødé ✓",
  PLAIN_URL: "postgres://db.example:5432/app@v2",
};

const kPrintEnvKeys =
  'exec node -e "process.stdout.write(JSON.stringify(Object.fromEntries(process.argv.slice(1).map((k) => [k, process.env[k] ?? null]))))" "$@"';

const runBash = (script, file, keys, cwd) =>
  JSON.parse(
    execFileSync("bash", ["-c", `${script}; shift; ${kPrintEnvKeys}`, "_", file, ...keys], {
      encoding: "utf8",
      cwd,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

const bashSourced = (file, keys, cwd) => runBash('set -a; . "$1"; set +a', file, keys, cwd);

// The raw reader ALPH-61 found in 67 Wintermute scripts and the boot-written
// gbrain wrapper: no quote handling, the value exported as read.
const rawReadLoopExported = (file, keys) =>
  runBash(
    'while IFS="=" read -r key value; do case "$key" in ""|\\#*) continue ;; esac; export "$key=$value"; done < "$1"',
    file,
    keys,
  );

// Built at runtime so the fixture is not a credential-shaped literal.
const postgresUrl = (password, query) =>
  ["postgres://gbrain", ":", password, "@db.example:5432/gbrain", query].join("");

describe("env-file-format", () => {
  it.each([
    ["plain-value_1.2/3:4@5%6+7=8,9-0", "plain-value_1.2/3:4@5%6+7=8,9-0"],
    ["", ""],
    ["a b", "'a b'"],
    ["$HOME", "'$HOME'"],
    ['say "hi"', "'say \"hi\"'"],
    ["it's", '"it\'s"'],
    ["'x'", "\"'x'\""],
    ['"x"', "'\"x\"'"],
    ["a?b*c!d[e]^f{g}", "a?b*c!d[e]^f{g}"],
    ["ünïcødé✓日本", "ünïcødé✓日本"],
    ["x=y=", "x=y="],
    ["=lead", "'=lead'"],
    ["~/x", "'~/x'"],
    ["#x", "'#x'"],
    ["a&b", "'a&b'"],
    ["a(b)", "'a(b)'"],
    ["a\u00a0b", "'a\u00a0b'"],
    ["a\u200bb", "'a\u200bb'"],
  ])("writes %j as %s", (value, text) => {
    expect(formatEnvValue(value)).toEqual({ text, exact: true });
  });

  it("writes a single quote mixed with a double quote, $, backtick or backslash in bash form, flagged not exact", () => {
    for (const value of ["it's \"x\"", "it's $x", "it's " + kBacktick + "x" + kBacktick, "it's \\x"]) {
      const { text, exact } = formatEnvValue(value);
      expect(exact).toBe(false);
      expect(decodeEnvValue(text)).toBe(value);
    }
    expect(formatEnvValue("a'b$c").text).toBe("'a'\\''b$c'");
  });

  it("reads legacy bare lines exactly as before", () => {
    for (const line of ["K=a #b", "K=k=v=w", "K=it's", "K=x -- <paths>", "K='lonely", 'K="lonely', "K='a'b", "K='a'#b", "K=   lead"]) {
      expect(parseEnvLine(line)).toEqual({ key: "K", value: line.slice(2) });
    }
    expect(parseEnvLine("  K = spaced  ")).toEqual({ key: "K", value: " spaced" });
    expect(parseEnvLine("# K=v")).toBeNull();
    expect(parseEnvLine("")).toBeNull();
    expect(parseEnvLine("no-equals")).toBeNull();
  });

  it("reads hand-quoted lines the way bash does", () => {
    expect(parseEnvLine("K='x'")).toEqual({ key: "K", value: "x" });
    expect(parseEnvLine('K="x y"')).toEqual({ key: "K", value: "x y" });
    expect(parseEnvLine("K='a b' # note")).toEqual({ key: "K", value: "a b" });
    expect(parseEnvLine('K="a b" # note')).toEqual({ key: "K", value: "a b" });
    expect(parseEnvLine("K='it'\\''s'")).toEqual({ key: "K", value: "it's" });
    expect(parseEnvLine("export K='v w'")).toEqual({ key: "K", value: "v w" });
    expect(parseEnvLine("K=''")).toEqual({ key: "K", value: "" });
  });

  it("round-trips every nasty value through format and parse", () => {
    for (const value of Object.values(kNastyValues)) {
      expect(parseEnvLine("K=" + formatEnvValue(value).text).value).toBe(value);
    }
  });

  it("refuses a changed value with a line break or no exact form, naming the key and never the value", () => {
    const current = [
      { key: "LEGACY", value: "it's $odd" },
      { key: "PLAIN", value: "x" },
    ];
    expect(findUnwritableEnvValue([{ key: "LEGACY", value: "it's $odd" }, { key: "PLAIN", value: "y z" }], current)).toBeNull();
    for (const value of ["one\ntwo", "a\rb", "a\u2028b", "a\u0000b"]) {
      expect(findUnwritableEnvValue([{ key: "NEW_KEY", value }], current)).toMatchObject({
        key: "NEW_KEY",
        code: "env_value_line_break",
        error: expect.stringContaining("line break or NUL character"),
      });
    }
    const refused = findUnwritableEnvValue([{ key: "PLAIN", value: "it's $secret-ish" }], current);
    expect(refused).toMatchObject({ key: "PLAIN", code: "env_value_unrepresentable" });
    expect(refused.error).toContain("PLAIN");
    expect(refused.error).not.toContain("secret-ish");
    expect(refused.error).toContain("deployment environment");
  });
});

describe("writeEnvFile output is read the same by bash, OpenClaw's dotenv and every AlphaClaw reader", { retry: 0 }, () => {
  let tmpDir;
  let previousRootDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-env-format-"));
    previousRootDir = process.env.ALPHACLAW_ROOT_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[require.resolve(envModulePath)];
    delete require.cache[require.resolve(constantsModulePath)];
    if (previousRootDir === undefined) delete process.env.ALPHACLAW_ROOT_DIR;
    else process.env.ALPHACLAW_ROOT_DIR = previousRootDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips nasty values byte for byte", () => {
    const env = loadEnvModule(tmpDir);
    env.writeEnvFile(Object.entries(kNastyValues).map(([key, value]) => ({ key, value })));
    const file = path.join(tmpDir, ".env");
    const content = fs.readFileSync(file, "utf8");

    expect(content.endsWith("\n")).toBe(true);
    expect(bashSourced(file, Object.keys(kNastyValues))).toEqual(kNastyValues);
    expect(openclawDotenvParse(content)).toEqual(kNastyValues);
    expect(Object.fromEntries(env.readEnvFile().map(({ key, value }) => [key, value]))).toEqual(kNastyValues);
    expect(Object.fromEntries(parseEnvFileContent(content).map(({ key, value }) => [key, value]))).toEqual(kNastyValues);
    expect(parseEnvFileText(content)).toEqual(kNastyValues);
  });

  it("leaves plain values bare so most lines read the same in every version", () => {
    const env = loadEnvModule(tmpDir);
    env.writeEnvFile([
      { key: "OPENAI_API_KEY", value: "sk-proj-abc_DEF-123" },
      { key: "GITHUB_WORKSPACE_REPO", value: "owner/repo" },
      { key: "SPACED", value: "a b" },
    ]);
    expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf8")).toBe(
      ["OPENAI_API_KEY=sk-proj-abc_DEF-123", "GITHUB_WORKSPACE_REPO=owner/repo", "SPACED='a b'", ""].join("\n"),
    );
  });

  it("leaves values with ? * ! [ ] ^ { } and non-ASCII bare, and every reader, raw IFS read loops included, gets them byte for byte", () => {
    const values = {
      DB_URL: postgresUrl("fixture!pw*", "?sslmode=require"),
      PASSWORD: ["fixture", "?pw!*"].join(""),
      GLOBS: "*",
      CLASS: "[a]",
      QMARK: "?",
      BRACES: "pre{1..3,x}post",
      CARET: "a^b",
      BANGS: "!!",
      NON_ASCII: "ünïcødé✓日本語",
      TRAILING_EQUALS: "abc==",
    };
    const env = loadEnvModule(tmpDir);
    env.writeEnvFile(Object.entries(values).map(([key, value]) => ({ key, value })));
    const file = path.join(tmpDir, ".env");
    const content = fs.readFileSync(file, "utf8");
    // Files a glob or brace expansion would match, were the values expanded.
    for (const name of ["a", "b", "x", "pre1post"]) fs.writeFileSync(path.join(tmpDir, name), "");

    expect(content).toBe(`${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
    expect(bashSourced(file, Object.keys(values), tmpDir)).toEqual(values);
    expect(rawReadLoopExported(file, Object.keys(values))).toEqual(values);
    expect(openclawDotenvParse(content)).toEqual(values);
    expect(Object.fromEntries(env.readEnvFile().map(({ key, value }) => [key, value]))).toEqual(values);
    expect(parseEnvFileText(content)).toEqual(values);
  });

  it("still quotes a postgres URL whose query has &, which a raw read loop then sees quoted", () => {
    const value = postgresUrl("fixture!pw*", "?sslmode=require&application_name=gbrain");
    const env = loadEnvModule(tmpDir);
    env.writeEnvFile([{ key: "DB_URL", value }]);
    const file = path.join(tmpDir, ".env");
    const content = fs.readFileSync(file, "utf8");

    expect(content).toBe(`DB_URL='${value}'\n`);
    expect(bashSourced(file, ["DB_URL"])).toEqual({ DB_URL: value });
    expect(openclawDotenvParse(content).DB_URL).toBe(value);
    expect(rawReadLoopExported(file, ["DB_URL"])).toEqual({ DB_URL: `'${value}'` });
  });

  it("an unquoted Wintermute-shaped file loses every later key in bash; the next save rewrites it and they load", () => {
    const file = path.join(tmpDir, ".env");
    fs.writeFileSync(
      file,
      [
        "FIRST_KEY=first",
        "ALPHACLAW_GIT_WRITER_COMMAND=alphaclaw git-writer -- <paths>",
        "SUPABASE_URL=https://example.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY=fixture",
      ].join("\n"),
    );
    const keys = ["FIRST_KEY", "ALPHACLAW_GIT_WRITER_COMMAND", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
    expect(bashSourced(file, keys)).toMatchObject({
      FIRST_KEY: "first",
      SUPABASE_URL: null,
      SUPABASE_SERVICE_ROLE_KEY: null,
    });

    const env = loadEnvModule(tmpDir);
    const before = env.readEnvFile();
    env.updateEnvFile((vars) => vars);
    expect(env.readEnvFile()).toEqual(before);
    expect(bashSourced(file, keys)).toEqual({
      FIRST_KEY: "first",
      ALPHACLAW_GIT_WRITER_COMMAND: "alphaclaw git-writer -- <paths>",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fixture",
    });
  });

  it("drops trailing whitespace (as the line trim on read always did) and NUL before writing", () => {
    const env = loadEnvModule(tmpDir);
    env.writeEnvFile([{ key: "PASTED_KEY", value: "sk-pas\u0000ted  " }]);
    expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf8")).toBe("PASTED_KEY=sk-pasted\n");
  });

  it("keeps a legacy value no form can carry in bash form, warns once with the key name only, and pins dotenv's misread", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = loadEnvModule(tmpDir);
    const value = "it's $fixture-odd";
    env.writeEnvFile([{ key: "LEGACY_ODD", value }]);
    env.writeEnvFile([{ key: "LEGACY_ODD", value }]);
    const file = path.join(tmpDir, ".env");
    const content = fs.readFileSync(file, "utf8");

    expect(bashSourced(file, ["LEGACY_ODD"])).toEqual({ LEGACY_ODD: value });
    expect(env.readEnvFile()).toEqual([{ key: "LEGACY_ODD", value }]);
    expect(openclawDotenvParse(content).LEGACY_ODD).not.toBe(value);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("LEGACY_ODD");
    expect(warn.mock.calls[0][0]).not.toContain("fixture-odd");
  });
});
