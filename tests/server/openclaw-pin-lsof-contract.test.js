// Pin contract for the lsof shim (bug #137). The graceful stop step
// (`openclaw gateway restart --wait`) only works because the pinned OpenClaw
// discovers the gateway listener through lsof in a shape the shim
// (lib/server/lsof-shim) reproduces. This test reads the installed dist and
// pins the four facts the shim and the ask preflight depend on; when a pin
// bump moves any of them, the message below says what to remove.
const fs = require("fs");
const path = require("path");

const kDistDir = path.resolve(__dirname, "../../node_modules/openclaw/dist");
const kRetire =
  "the pin no longer needs lsof — delete the ask preflight and the shim (lib/server/lsof-shim) and this test";

const readChunks = (prefix) => {
  const names = fs.readdirSync(kDistDir).filter((name) => name.startsWith(prefix) && name.endsWith(".mjs"));
  return names.map((name) => ({ name, text: fs.readFileSync(path.join(kDistDir, name), "utf8") }));
};

const explain = (fact) => `${fact}; if OpenClaw now discovers the listener another way, ${kRetire}`;

describe("openclaw pin: lsof contract behind `gateway restart`", () => {
  const pin = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")).dependencies.openclaw;
  const installed = JSON.parse(fs.readFileSync(path.join(kDistDir, "..", "package.json"), "utf8")).version;

  it("reads the pinned build", () => {
    expect(installed, "node_modules/openclaw is not the pin — run npm install").toBe(pin);
  });

  it("resolveLsofCommandSync tries /usr/bin/lsof, /usr/sbin/lsof (X_OK) and falls back to bare `lsof` on PATH", () => {
    const chunks = readChunks("ports-lsof-");
    expect(chunks.length, explain("no ports-lsof-*.mjs chunk in the dist")).toBeGreaterThan(0);
    const text = chunks.map((chunk) => chunk.text).join("\n");
    expect(text, explain("LSOF_CANDIDATES lost its Linux order")).toMatch(
      /: \["\/usr\/bin\/lsof", "\/usr\/sbin\/lsof"\]/,
    );
    expect(text, explain("resolveLsofCommandSync no longer probes X_OK")).toMatch(
      /function resolveLsofCommandSync\(\) \{[\s\S]*?fs\.accessSync\(candidate, fs\.constants\.X_OK\);[\s\S]*?return "lsof";\n\}/,
    );
  });

  it("the stale-pid scan spawns lsof as [-nP, -iTCP:<port>, -sTCP:LISTEN, -Fpc] under the diagnostic env", () => {
    const chunks = readChunks("restart-stale-pids-");
    expect(chunks.length, explain("no restart-stale-pids-*.mjs chunk in the dist")).toBeGreaterThan(0);
    const text = chunks.map((chunk) => chunk.text).join("\n");
    const scan = /function findGatewayPidsOnPortWithProtectedPidSync\([\s\S]*?\n\}/.exec(text)?.[0];
    expect(scan, explain("findGatewayPidsOnPortWithProtectedPidSync is gone")).toBeTruthy();
    expect(scan).toMatch(/const lsof = resolveLsofCommandSync\(\);/);
    expect(scan).toMatch(
      /spawnSync\(lsof, \[\s*"-nP",\s*`-iTCP:\$\{port\}`,\s*"-sTCP:LISTEN",\s*"-Fpc"\s*\], \{\s*env: resolveDiagnosticProcessEnv\(\),/,
    );
    // ENOENT → [] is the bug: a missing binary reads as "no listeners".
    expect(scan, explain("ENOENT is no longer swallowed as 'no listeners'")).toMatch(/if \(code === "ENOENT"\) return \[\];/);
    // status 1 → [] is lsof's "nothing matched" — the shim's free answer.
    expect(scan, explain("status 1 is no longer 'port free'")).toMatch(/if \(res\.status === 1\) return \[\];/);
    // Any other non-zero status (the shim's exit 2) warns and skips — never
    // treated as free.
    expect(scan).toMatch(/if \(res\.status !== 0\) \{[\s\S]*?return \[\];/);
    expect(text, explain("parsePidsFromLsofOutput no longer keys on `p` lines")).toMatch(
      /line\.startsWith\("p"\) \? parseStrictPositiveInteger\(line\.slice\(1\)\)/,
    );
  });

  it("pollPortOnce reads status 1 + empty stdout as free and status 1 + output as busy", () => {
    const text = readChunks("restart-stale-pids-").map((chunk) => chunk.text).join("\n");
    const poll = /function pollPortOnce\(port\) \{[\s\S]*?\n\}/.exec(text)?.[0];
    expect(poll, explain("pollPortOnce is gone")).toBeTruthy();
    expect(poll).toMatch(/"-sTCP:LISTEN",\s*"-Fpc"/);
    expect(poll).toMatch(/if \(res\.status === 1\) return res\.stdout\.trim\(\) \? \{ free: false \} : \{ free: true \};/);
  });

  it("`gateway restart` under an external supervisor reaches that scan (the refusal AlphaClaw works around)", () => {
    const lifecycle = readChunks("lifecycle-").map((chunk) => chunk.text).join("\n");
    expect(lifecycle, explain("the external-supervisor restart no longer refuses on an empty scan")).toMatch(
      /No verified gateway process is listening on port \$\{lockIdentity\.port\}/,
    );
    const schtasks = readChunks("schtasks-").map((chunk) => chunk.text).join("\n");
    expect(schtasks, explain("findVerifiedGatewayListenerPidsOnPortSync no longer uses findGatewayPidsOnPortSync")).toMatch(
      /function findVerifiedGatewayListenerPidsOnPortSync\(port, context = \{\}\) \{\s*const rawPids = process\.platform === "win32" \? [\w$]+\(port\) : findGatewayPidsOnPortSync\(port\);/,
    );
  });

  it("other lsof call sites use the -FpFc / -FpFcn field forms the shim also answers", () => {
    const text = readChunks("ports-").map((chunk) => chunk.text).join("\n");
    const forms = new Set([...text.matchAll(/"-F([pFcn]+)"/g)].map((m) => m[1]));
    expect([...forms].sort()).toEqual(["pFc", "pFcn"]);
  });
});
