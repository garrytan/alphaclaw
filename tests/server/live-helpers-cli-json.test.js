const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Hermetic coverage for the live tier's `--json` CLI contract helper (fix wave
// F222/F115). live-helpers only touches fs/os/path at load time and the live
// tier stays disabled here (OPENCLAW_LIVE_E2E unset), so this exercises the
// parser and the spawn wrapper against tiny node scripts instead of openclaw.
const { parseSingleJsonDocument, runCliJson } = require("../live/live-helpers");

const writeScript = (dir, name, source) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
};

describe("live-helpers CLI --json contract", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-cli-json-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("parseSingleJsonDocument", () => {
    it("accepts exactly one document (surrounding whitespace allowed)", () => {
      expect(parseSingleJsonDocument('  {"file":{"a":1}}\n')).toEqual({ file: { a: 1 } });
      expect(parseSingleJsonDocument("[1,2]")).toEqual([1, 2]);
    });

    it("names an EMPTY stdout and points at the env scrub (the VITEST-inherited silence)", () => {
      expect(() => parseSingleJsonDocument("", { label: "beta approvals get" })).toThrow(
        /beta approvals get: expected exactly one JSON document .* EMPTY .*scrubTestRunnerEnv/,
      );
      expect(() => parseSingleJsonDocument("   \n")).toThrow(/EMPTY/);
    });

    it("rejects a banner before the document and quotes the stdout", () => {
      expect(() =>
        parseSingleJsonDocument('openclaw 2026.9.1-beta.1 starting\n{"file":{}}', { label: "beta" }),
      ).toThrow(/not a single JSON document — found a JSON document surrounded by non-JSON text.*banner.*stdout\(\d+B\): "openclaw 2026\.9\.1-beta\.1 starting/s);
    });

    it("rejects TWO documents instead of silently taking one", () => {
      expect(() => parseSingleJsonDocument('{"a":1}\n{"a":2}\n')).toThrow(/found 2 JSON documents/);
    });

    it("reports junk as no parseable document and appends the stderr tail when given", () => {
      expect(() => parseSingleJsonDocument("not json at all", { stderr: "warn: something" })).toThrow(
        /found no parseable JSON document.*stderr: "warn: something"/s,
      );
    });
  });

  describe("runCliJson", () => {
    it("returns the parsed document; stderr noise never pollutes the contract", () => {
      const bin = writeScript(
        dir,
        "ok.js",
        'process.stderr.write("[cli] chatty warning\\n"); process.stdout.write(JSON.stringify({ file: { ok: true }, args: process.argv.slice(2) }));',
      );
      expect(runCliJson(bin, ["approvals", "get", "--json"], { label: "fake" })).toEqual({
        file: { ok: true },
        args: ["approvals", "get", "--json"],
      });
    });

    it("scrubs the test-runner env for the child (NODE_OPTIONS and VITEST*) but keeps everything else", () => {
      const bin = writeScript(
        dir,
        "env.js",
        'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => k === "NODE_OPTIONS" || k.startsWith("VITEST") || k === "KEEP_ME").sort()));',
      );
      const out = runCliJson(bin, [], {
        env: { ...process.env, NODE_OPTIONS: "--x", VITEST: "true", VITEST_POOL_ID: "1", KEEP_ME: "1" },
      });
      expect(out).toEqual(["KEEP_ME"]);
    });

    it("a non-zero exit fails with the command, the status and the stderr tail — not a parse error", () => {
      const bin = writeScript(
        dir,
        "fail.js",
        'process.stderr.write("Error: state db locked\\n"); process.exit(3);',
      );
      expect(() => runCliJson(bin, ["approvals", "get", "--json"], { label: "pin" })).toThrow(
        /pin: node fail\.js approvals get --json exited with status 3\.\nstderr: "Error: state db locked/,
      );
    });

    it("a banner on stdout FAILS the contract even when the exit is 0", () => {
      const bin = writeScript(
        dir,
        "banner.js",
        'process.stdout.write("Loaded plugins: 3\\n" + JSON.stringify({ file: {} }) + "\\n");',
      );
      expect(() => runCliJson(bin, ["config", "get", "--json"])).toThrow(/surrounded by non-JSON text/);
    });

    it("an empty stdout FAILS the contract (the silenced-CLI failure mode) instead of resolving undefined", () => {
      const bin = writeScript(dir, "silent.js", "process.exit(0);");
      expect(() => runCliJson(bin, ["approvals", "get", "--json"])).toThrow(/EMPTY/);
    });

    it("passes `input` through to the child's stdin", () => {
      const bin = writeScript(
        dir,
        "stdin.js",
        'let d=""; process.stdin.on("data", (c) => d += c); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ got: d })));',
      );
      expect(runCliJson(bin, [], { input: "hello" })).toEqual({ got: "hello" });
    });
  });
});
