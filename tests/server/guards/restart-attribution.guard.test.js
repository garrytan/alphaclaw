// Guard (f): every gateway restart is attributed (ALPH-17). The Oct 22 restart
// that killed an agent turn logged `op=-`: only the restart route passed an
// operation id, so nobody could tell the watchdog's memory mitigation had
// asked for it. Now the ladder mints an id for any caller, but the SOURCE can
// only come from the caller: pass `{ source, reason }` (watchdog:*, api:*,
// channels:*, team:*), or forward the caller's own options unchanged.
const { auditTree, formatHits } = require("./guard-utils");
const { scanUnattributedRestarts } = require("./scanners");

const kKnownOffenders = {};

describe("guard: every gateway restart names its source", () => {
  it("flags a bare or unattributed restart call and accepts attributed and forwarding ones (self-test)", () => {
    const fixture = [
      "await restartGateway();",
      "await coldRestartGateway({ shouldAbort });",
      'await restartGateway({ source: "channels:create", reason: id });',
      "await coldRestartGateway({ shouldAbort, ...attribution });",
      "restartGateway: (options) => restartGatewayWithReload(reloadEnv, options),",
      "const restartGateway = async (reloadEnv, options = {}) => {};",
      "async function runGatewayColdStart(opts) {}",
    ].join("\n");
    const hits = scanUnattributedRestarts(fixture, "lib/server/planted.js");
    expect(hits.map((h) => h.key)).toEqual([
      "lib/server/planted.js::restartGateway()",
      "lib/server/planted.js::coldRestartGateway({ shouldAbort })",
    ]);
  });

  it("has no unattributed restart calls outside the allowlist, and no stale entries", () => {
    const { unexpected, stale } = auditTree({
      roots: ["lib/server", "lib/server.js"],
      scan: scanUnattributedRestarts,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `Unattributed restart call(s) — pass { source, reason } (or forward the caller's options):\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(stale, `Stale allowlist entries:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});
