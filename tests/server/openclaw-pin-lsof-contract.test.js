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

const escapeId = (name) => name.replace(/\$/g, "\\$");
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
      /function resolveLsofCommandSync\(\) \{[\s\S]*?(?:fs\.accessSync\(candidate, fs\.constants\.X_OK\);|canAccessSync\([\w$]+, fs\.constants\.X_OK\))[\s\S]*?return "lsof";\n\}/,
    );
  });

  it("the stale-pid scan spawns lsof as [-nP, -iTCP:<port>, -sTCP:LISTEN, -Fpc] under the diagnostic env", () => {
    const chunks = readChunks("restart-stale-pids-");
    expect(chunks.length, explain("no restart-stale-pids-*.mjs chunk in the dist")).toBeGreaterThan(0);
    const text = chunks.map((chunk) => chunk.text).join("\n");
    // 2026.11.5 ships a minified dist: local names are mangled (`e`, `t`), so
    // the patterns below capture them instead of naming them.
    const scanMatch = /function findGatewayPidsOnPortWithProtectedPidSync\(([\w$]+), ([\w$]+)[^)]*\) \{[\s\S]*?\n\}/.exec(text);
    expect(scanMatch, explain("findGatewayPidsOnPortWithProtectedPidSync is gone")).toBeTruthy();
    const [scan, portArg, timeoutArg] = scanMatch;
    // 2026.10.5 moved the spawn into scanListeningPort, shared with pollPortOnce.
    expect(scan).toMatch(new RegExp(`const ([\\w$]+) = scanListeningPort\\(${escapeId(portArg)}, ${escapeId(timeoutArg)}\\);`));
    const res = new RegExp(`const ([\\w$]+) = scanListeningPort\\(`).exec(scan)[1];
    const spawnMatch = /function scanListeningPort\(([\w$]+), ([\w$]+)\) \{[\s\S]*?\n\}/.exec(text);
    expect(spawnMatch, explain("scanListeningPort is gone")).toBeTruthy();
    const [spawn, spawnPort] = spawnMatch;
    const lsofVar = /const ([\w$]+) = resolveLsofCommandSync\(\);/.exec(spawn)?.[1];
    expect(lsofVar, explain("scanListeningPort no longer resolves the lsof binary")).toBeTruthy();
    expect(spawn).toMatch(
      new RegExp(
        `spawnSync\\(${escapeId(lsofVar)}, \\[\\s*"-nP",\\s*\`-iTCP:\\$\\{${escapeId(spawnPort)}\\}\`,\\s*"-sTCP:LISTEN",\\s*"-Fpc"\\s*\\], \\{\\s*env: resolveDiagnosticProcessEnv\\(\\),`,
      ),
    );
    // ENOENT → [] is the bug: a missing binary reads as "no listeners".
    expect(scan, explain("ENOENT is no longer swallowed as 'no listeners'")).toMatch(/if \([\w$]+ === "ENOENT"\) return \[\];/);
    // status 1 → [] is lsof's "nothing matched" — the shim's free answer.
    expect(scan, explain("status 1 is no longer 'port free'")).toMatch(new RegExp(`if \\(${escapeId(res)}\\.status === 1\\) return \\[\\];`));
    // Any other non-zero status (the shim's exit 2) warns and skips — never
    // treated as free.
    expect(scan).toMatch(new RegExp(`if \\(${escapeId(res)}\\.status !== 0\\) \\{[\\s\\S]*?return \\[\\];`));
    expect(text, explain("parsePidsFromLsofOutput no longer keys on `p` lines")).toMatch(
      /([\w$]+)\.startsWith\("p"\) \? parseStrictPositiveInteger\(\1\.slice\(1\)\)/,
    );
  });

  it("pollPortOnce reads status 1 + empty stdout as free and status 1 + output as busy", () => {
    const text = readChunks("restart-stale-pids-").map((chunk) => chunk.text).join("\n");
    const pollMatch = /function pollPortOnce\(([\w$]+)\) \{[\s\S]*?\n\}/.exec(text);
    expect(pollMatch, explain("pollPortOnce is gone")).toBeTruthy();
    const [poll, pollPort] = pollMatch;
    const res = new RegExp(`const ([\\w$]+) = scanListeningPort\\(${escapeId(pollPort)}, POLL_SPAWN_TIMEOUT_MS\\);`).exec(poll)?.[1];
    expect(res, explain("pollPortOnce no longer scans with POLL_SPAWN_TIMEOUT_MS")).toBeTruthy();
    expect(poll).toMatch(
      new RegExp(`if \\(${escapeId(res)}\\.status === 1\\) return ${escapeId(res)}\\.stdout\\.trim\\(\\) \\? \\{ free: false \\} : \\{ free: true \\};`),
    );
  });

  it("`gateway restart` under an external supervisor reaches that scan (the refusal AlphaClaw works around)", () => {
    const lifecycle = readChunks("lifecycle-").map((chunk) => chunk.text).join("\n");
    expect(lifecycle, explain("the external-supervisor restart no longer refuses on an empty scan")).toMatch(
      /No verified gateway process is listening on port \$\{[\w$]+\.port\}/,
    );
    // 2026.11.5 moved it from schtasks-*.mjs to gateway-processes-*.mjs.
    const schtasks = [...readChunks("schtasks-"), ...readChunks("gateway-processes-")].map((chunk) => chunk.text).join("\n");
    expect(schtasks, explain("findVerifiedGatewayListenerPidsOnPortSync no longer uses findGatewayPidsOnPortSync")).toMatch(
      /function findVerifiedGatewayListenerPidsOnPortSync\(([\w$]+), [\w$]+ = \{\}\) \{\s*const [\w$]+ = process\.platform === "win32" \? [\w$]+\(\1\) : findGatewayPidsOnPortSync\(\1\);/,
    );
  });

  it("other lsof call sites use the -FpFc / -FpFcn field forms the shim also answers", () => {
    const text = readChunks("ports-").map((chunk) => chunk.text).join("\n");
    const forms = new Set([...text.matchAll(/"-F([pFcn]+)"/g)].map((m) => m[1]));
    expect([...forms].sort()).toEqual(["pFc", "pFcn"]);
  });
});
