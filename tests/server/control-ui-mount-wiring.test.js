const fs = require("fs");
const path = require("path");

// Source-scan pins for the Control UI mount contract (control-ui-mount.js).
// The restore repair in openclaw-channel-sync.js only runs when lib/server.js
// injects ensureGatewayProxyConfig into createOpenclawChannelSync({...}). A
// hook-called-once unit test proves the repair works WHEN wired; only the
// production call site proves it IS wired — dropping the option there would
// fail no other test. Same pattern as proxy-structural-guard.test.js.

const kRepoRoot = path.resolve(__dirname, "..", "..");
// Matches the option as a PROPERTY of the argument object (shorthand or
// `ensureGatewayProxyConfig: …`), never a mention inside a comment.
const kEnsureHookProperty = /^\s*ensureGatewayProxyConfig\s*[,:]/m;
const readSource = (relPath) =>
  fs.readFileSync(path.join(kRepoRoot, relPath), "utf8");

const kChannelSyncCall = "createOpenclawChannelSync({";
const kBlockClose = "\n});";
// The call's argument block: from the opening `({` to the first `});` at
// column 0 (lib/server.js declares the service at top level).
const extractChannelSyncCallBlock = (source) => {
  const start = source.indexOf(kChannelSyncCall);
  if (start === -1) return null;
  const close = source.indexOf(kBlockClose, start);
  if (close === -1) return null;
  return source.slice(start, close + kBlockClose.length);
};

// Every consumer of the mount contract imports the ONE owner module. A local
// "/openclaw" literal or a private ALPHACLAW_CONTROL_UI_MOUNT read would let
// the proxy, the config writer, the auth rule and the WS guard disagree
// within one process — the split-brain the leaf module exists to prevent.
const kMountConsumers = [
  { file: "lib/server/routes/proxy.js", requireSpec: 'require("../control-ui-mount")' },
  { file: "lib/server/routes/auth.js", requireSpec: 'require("../control-ui-mount")' },
  { file: "lib/server/watchdog-terminal-ws.js", requireSpec: 'require("./control-ui-mount")' },
  { file: "lib/server/gateway.js", requireSpec: 'require("./control-ui-mount")' },
];

describe("control-ui-mount wiring (source scan)", () => {
  it("lib/server.js injects ensureGatewayProxyConfig into the channel-sync service", () => {
    const block = extractChannelSyncCallBlock(readSource("lib/server.js"));

    expect(block).not.toBeNull();
    // Scanner health: this is the real argument object (it names options
    // every server-side instance passes), not a truncated snippet.
    expect(block).toContain("isOnboarded");
    expect(block).toContain("restartProcess");
    expect(block.endsWith("});")).toBe(true);
    // The PROPERTY (shorthand or `key:`), not a mention in a comment — the
    // block carries prose about the restore repair that names the hook.
    expect(block).toMatch(kEnsureHookProperty);
  });

  it("scans the call's argument block only (guard sensitivity)", () => {
    // The identifier appearing elsewhere in the file (its import, another
    // caller) must never satisfy the pin above.
    const synthetic = [
      'const { ensureGatewayProxyConfig } = require("./server/gateway");',
      "const service = createOpenclawChannelSync({",
      "  isOnboarded,",
      "  // the restore re-applies via ensureGatewayProxyConfig (comment only)",
      "  restartProcess,",
      "});",
      "ensureGatewayProxyConfig();",
    ].join("\n");

    const block = extractChannelSyncCallBlock(synthetic);

    expect(block).toBe(
      "createOpenclawChannelSync({\n  isOnboarded,\n  // the restore re-applies via ensureGatewayProxyConfig (comment only)\n  restartProcess,\n});",
    );
    // A comment inside the block mentions the hook; the property pin must not
    // be satisfied by it.
    expect(block).not.toMatch(kEnsureHookProperty);
    expect(extractChannelSyncCallBlock("no call here")).toBeNull();
  });

  it.each(kMountConsumers)(
    "$file imports the mount contract from control-ui-mount.js",
    ({ file, requireSpec }) => {
      expect(readSource(file)).toContain(requireSpec);
    },
  );

  it("routes/proxy.js no longer rewrites /openclaw to the gateway root unconditionally", () => {
    // The pre-fix handler did `req.url = "/"` for the bare /openclaw route
    // (and stripped the prefix below it), which made the gateway stamp an
    // empty base path. Only the legacy-mode conditional prefix replace may
    // remain.
    expect(readSource("lib/server/routes/proxy.js")).not.toContain('req.url = "/"');
  });

  it("scans real files (fixture sanity)", () => {
    for (const relPath of ["lib/server.js", ...kMountConsumers.map((c) => c.file)]) {
      expect(fs.existsSync(path.join(kRepoRoot, relPath))).toBe(true);
    }
  });
});
