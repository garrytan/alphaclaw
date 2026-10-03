const fs = require("fs");
const path = require("path");

// Source-scan pins for the Control UI mount contract (control-ui-mount.js).
// Same pattern as proxy-structural-guard.test.js.

const kRepoRoot = path.resolve(__dirname, "..", "..");
const readSource = (relPath) =>
  fs.readFileSync(path.join(kRepoRoot, relPath), "utf8");

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
