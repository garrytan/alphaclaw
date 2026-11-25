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
// A string literal in any quote style, so the patterns read 2026.11.6's
// formatted dist and 2026.11.10's, which prints strings as template literals
// and drops the whitespace.
const kQ = "[\"'`]";
// One function's source, from its name to the brace that closes its body
// (a default parameter such as `t={}` comes before it), skipping braces
// inside string and template literals.
const functionSource = (text, name) => {
  const start = text.search(new RegExp(`function ${escapeId(name)}\\(`));
  if (start < 0) return null;
  let depth = 0;
  let quote = null;
  const body = /\)\s*\{/.exec(text.slice(start));
  if (!body) return null;
  for (let i = start + body.index + body[0].length - 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
};
const argsOf = (source) => /^function [\w$]+\(([^)]*)\)/.exec(source)[1].split(",").map((arg) => arg.split("=")[0].trim());

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
      new RegExp(`:\\s*\\[${kQ}/usr/bin/lsof${kQ},\\s*${kQ}/usr/sbin/lsof${kQ}\\]`),
    );
    const resolve = functionSource(text, "resolveLsofCommandSync");
    expect(resolve, explain("resolveLsofCommandSync is gone")).toBeTruthy();
    expect(resolve, explain("resolveLsofCommandSync no longer probes X_OK")).toMatch(
      new RegExp(`(?:fs\\.accessSync|canAccessSync)\\([\\w$]+,\\s*fs\\.constants\\.X_OK\\)[\\s\\S]*return\\s*${kQ}lsof${kQ};?\\s*\\}$`),
    );
  });

  it("the stale-pid scan spawns lsof as [-nP, -iTCP:<port>, -sTCP:LISTEN, -Fpc] under the diagnostic env", () => {
    const chunks = readChunks("restart-stale-pids-");
    expect(chunks.length, explain("no restart-stale-pids-*.mjs chunk in the dist")).toBeGreaterThan(0);
    const text = chunks.map((chunk) => chunk.text).join("\n");
    // Minified dists (2026.11.5 on) mangle local names (`e`, `t`), so the
    // patterns below capture them instead of naming them.
    const scan = functionSource(text, "findGatewayPidsOnPortWithProtectedPidSync");
    expect(scan, explain("findGatewayPidsOnPortWithProtectedPidSync is gone")).toBeTruthy();
    const [portArg, timeoutArg] = argsOf(scan);
    // 2026.10.5 moved the spawn into scanListeningPort, shared with pollPortOnce.
    const resMatch = new RegExp(`const ([\\w$]+)\\s*=\\s*scanListeningPort\\(${escapeId(portArg)},\\s*${escapeId(timeoutArg)}\\);`).exec(scan);
    expect(resMatch, explain("the stale-pid scan no longer calls scanListeningPort")).toBeTruthy();
    const res = resMatch[1];
    const spawn = functionSource(text, "scanListeningPort");
    expect(spawn, explain("scanListeningPort is gone")).toBeTruthy();
    const [spawnPort] = argsOf(spawn);
    const lsofVar = /const ([\w$]+)\s*=\s*resolveLsofCommandSync\(\);/.exec(spawn)?.[1];
    expect(lsofVar, explain("scanListeningPort no longer resolves the lsof binary")).toBeTruthy();
    expect(spawn).toMatch(
      new RegExp(
        `spawnSync\\(${escapeId(lsofVar)},\\s*\\[\\s*${kQ}-nP${kQ},\\s*\`-iTCP:\\$\\{${escapeId(spawnPort)}\\}\`,\\s*${kQ}-sTCP:LISTEN${kQ},\\s*${kQ}-Fpc${kQ}\\s*\\],\\s*\\{\\s*env:\\s*resolveDiagnosticProcessEnv\\(\\),`,
      ),
    );
    // ENOENT → [] is the bug: a missing binary reads as "no listeners".
    expect(scan, explain("ENOENT is no longer swallowed as 'no listeners'")).toMatch(
      new RegExp(`if\\s*\\([\\w$]+\\s*===\\s*${kQ}ENOENT${kQ}\\)\\s*return\\s*\\[\\];`),
    );
    // status 1 → [] is lsof's "nothing matched" — the shim's free answer.
    expect(scan, explain("status 1 is no longer 'port free'")).toMatch(
      new RegExp(`if\\s*\\(${escapeId(res)}\\.status\\s*===\\s*1\\)\\s*return\\s*\\[\\];`),
    );
    // Any other non-zero status (the shim's exit 2) warns and skips — never
    // treated as free.
    expect(scan).toMatch(new RegExp(`if\\s*\\(${escapeId(res)}\\.status\\s*!==\\s*0\\)\\s*\\{[\\s\\S]*?return\\s*\\[\\];?\\s*\\}`));
    expect(text, explain("parsePidsFromLsofOutput no longer keys on `p` lines")).toMatch(
      new RegExp(`([\\w$]+)\\.startsWith\\(${kQ}p${kQ}\\)\\s*\\?\\s*parseStrictPositiveInteger\\(\\1\\.slice\\(1\\)\\)`),
    );
  });

  it("pollPortOnce reads status 1 + empty stdout as free and status 1 + output as busy", () => {
    const text = readChunks("restart-stale-pids-").map((chunk) => chunk.text).join("\n");
    const poll = functionSource(text, "pollPortOnce");
    expect(poll, explain("pollPortOnce is gone")).toBeTruthy();
    const [pollPort] = argsOf(poll);
    const res = new RegExp(`const ([\\w$]+)\\s*=\\s*scanListeningPort\\(${escapeId(pollPort)},\\s*POLL_SPAWN_TIMEOUT_MS\\);`).exec(poll)?.[1];
    expect(res, explain("pollPortOnce no longer scans with POLL_SPAWN_TIMEOUT_MS")).toBeTruthy();
    expect(poll).toMatch(
      new RegExp(
        `if\\s*\\(${escapeId(res)}\\.status\\s*===\\s*1\\)\\s*return\\s*${escapeId(res)}\\.stdout\\.trim\\(\\)\\s*\\?\\s*\\{\\s*free:\\s*false\\s*\\}\\s*:\\s*\\{\\s*free:\\s*true\\s*\\};`,
      ),
    );
  });

  it("`gateway restart` under an external supervisor reaches that scan (the refusal AlphaClaw works around)", () => {
    const lifecycle = readChunks("lifecycle-").map((chunk) => chunk.text).join("\n");
    expect(lifecycle, explain("the external-supervisor restart no longer refuses on an empty scan")).toMatch(
      /No verified gateway process is listening on port \$\{[\w$]+\.port\}/,
    );
    // 2026.11.5 moved it from schtasks-*.mjs to gateway-processes-*.mjs;
    // 2026.11.10 moved the platform choice into gatewayListenerPidsOnPort.
    const text = [...readChunks("schtasks-"), ...readChunks("gateway-processes-")].map((chunk) => chunk.text).join("\n");
    const verified = functionSource(text, "findVerifiedGatewayListenerPidsOnPortSync");
    expect(verified, explain("findVerifiedGatewayListenerPidsOnPortSync is gone")).toBeTruthy();
    const [port] = argsOf(verified);
    const viaHelper = new RegExp(`gatewayListenerPidsOnPort\\(${escapeId(port)}\\)`).test(verified);
    const lookup = viaHelper ? functionSource(text, "gatewayListenerPidsOnPort") : verified;
    const [lookupPort] = argsOf(lookup);
    expect(lookup, explain("findVerifiedGatewayListenerPidsOnPortSync no longer uses findGatewayPidsOnPortSync")).toMatch(
      new RegExp(
        `const [\\w$]+\\s*=\\s*process\\.platform\\s*===\\s*${kQ}win32${kQ}\\s*\\?\\s*[\\w$]+\\(${escapeId(lookupPort)}\\)\\s*:\\s*findGatewayPidsOnPortSync\\(${escapeId(lookupPort)}\\);`,
      ),
    );
  });

  it("other lsof call sites use the -FpFc / -FpFcn field forms the shim also answers", () => {
    const text = readChunks("ports-").map((chunk) => chunk.text).join("\n");
    const forms = new Set([...text.matchAll(new RegExp(`${kQ}-F([pFcn]+)${kQ}`, "g"))].map((m) => m[1]));
    expect([...forms].sort()).toEqual(["pFc", "pFcn"]);
  });
});
