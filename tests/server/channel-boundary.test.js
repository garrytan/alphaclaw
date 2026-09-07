// crossesChannelBoundary (issue #79, Stage 4a): the ONE predicate the server
// backup hard gate and the Upgrade tab confirm share. Truth table over the two
// arms (prerelease↔stable flip × channel-name change), the "either direction"
// rule, the persisted-provenance rule (Codex 19) and parity with the two
// pre-existing prerelease detectors it must never drift from.
const fs = require("fs");
const path = require("path");

const kModulePath = path.resolve(__dirname, "../../lib/channel-boundary.js");
const {
  kDefaultChannel,
  normalizeChannelName,
  isPrereleaseVersion,
  crossesChannelBoundary,
} = require(kModulePath);

describe("channel-boundary: crossesChannelBoundary four-way truth table", () => {
  // rows: [label, input, expected]
  const kTable = [
    // 1. no version flip, same channel name → not a boundary
    [
      "stable→stable, base→base",
      { installedVersion: "2026.9.1", targetVersion: "2026.9.2", currentChannel: "stable", targetChannel: "stable" },
      false,
    ],
    [
      "beta→beta, prerelease→prerelease",
      { installedVersion: "2026.9.1-beta.1", targetVersion: "2026.9.1-beta.2", currentChannel: "beta", targetChannel: "beta" },
      false,
    ],
    [
      "dev→dev, shas are not versions",
      { installedVersion: "0f3a9c1", targetVersion: "9b2e77d", currentChannel: "dev", targetChannel: "dev" },
      false,
    ],
    // 2. version flip, same channel name → boundary (the arm the UI lacked)
    [
      "beta channel, prerelease→base",
      { installedVersion: "2026.9.1-beta.1", targetVersion: "2026.9.2", currentChannel: "beta", targetChannel: "beta" },
      true,
    ],
    [
      "stable channel, base→prerelease",
      { installedVersion: "2026.9.2", targetVersion: "2026.9.3-beta.1", currentChannel: "stable", targetChannel: "stable" },
      true,
    ],
    // 3. no version flip, channel name change → boundary (the arm the server lacked)
    [
      "stable→beta, same base version",
      { installedVersion: "2026.9.2", targetVersion: "2026.9.2", currentChannel: "stable", targetChannel: "beta" },
      true,
    ],
    [
      "stable→dev",
      { installedVersion: "2026.9.2", targetVersion: "9b2e77d", currentChannel: "stable", targetChannel: "dev" },
      true,
    ],
    [
      "beta→stable, both prerelease",
      { installedVersion: "2026.9.1-beta.1", targetVersion: "2026.9.1-beta.2", currentChannel: "beta", targetChannel: "stable" },
      true,
    ],
    // 4. version flip AND channel name change → boundary
    [
      "stable→beta, base→prerelease",
      { installedVersion: "2026.9.2", targetVersion: "2026.9.3-beta.1", currentChannel: "stable", targetChannel: "beta" },
      true,
    ],
    [
      "beta→stable, prerelease→base",
      { installedVersion: "2026.9.1-beta.1", targetVersion: "2026.9.2", currentChannel: "beta", targetChannel: "stable" },
      true,
    ],
  ];

  it.each(kTable)("%s → %j", (_label, input, expected) => {
    expect(crossesChannelBoundary(input)).toBe(expected);
  });

  it("is symmetric: swapping the endpoints never changes the verdict", () => {
    for (const [, input, expected] of kTable) {
      const swapped = {
        installedVersion: input.targetVersion,
        targetVersion: input.installedVersion,
        currentChannel: input.targetChannel,
        targetChannel: input.currentChannel,
      };
      expect(crossesChannelBoundary(swapped)).toBe(expected);
    }
  });
});

describe("channel-boundary: version arm details", () => {
  it("a bare numeric suffix is a hotfix, not a prerelease — no boundary on the stable line", () => {
    expect(
      crossesChannelBoundary({
        installedVersion: "2026.7.1",
        targetVersion: "2026.7.1-2",
        currentChannel: "stable",
        targetChannel: "stable",
      }),
    ).toBe(false);
    expect(
      crossesChannelBoundary({
        installedVersion: "2026.7.1-2",
        targetVersion: "2026.8.1-beta.3",
        currentChannel: "stable",
        targetChannel: "stable",
      }),
    ).toBe(true);
  });

  it("tolerates GitHub's v-prefix and surrounding whitespace", () => {
    expect(
      crossesChannelBoundary({
        installedVersion: " v2026.9.2 ",
        targetVersion: "v2026.9.3-rc.1",
        currentChannel: "stable",
        targetChannel: "stable",
      }),
    ).toBe(true);
    expect(
      crossesChannelBoundary({
        installedVersion: "v2026.9.2",
        targetVersion: " 2026.9.3 ",
        currentChannel: "stable",
        targetChannel: "stable",
      }),
    ).toBe(false);
  });

  it("needs both endpoints: nothing installed (or no target) leaves the verdict to the channel arm", () => {
    // Fresh box, prerelease target, same channel: no direction to cross —
    // the caller's own isPrereleaseTarget term covers the target-only view.
    for (const installedVersion of [null, undefined, "", "   "]) {
      expect(
        crossesChannelBoundary({
          installedVersion,
          targetVersion: "2026.9.3-beta.1",
          currentChannel: "stable",
          targetChannel: "stable",
        }),
      ).toBe(false);
      // …but a channel-name change still crosses regardless of versions.
      expect(
        crossesChannelBoundary({
          installedVersion,
          targetVersion: "2026.9.3-beta.1",
          currentChannel: "stable",
          targetChannel: "beta",
        }),
      ).toBe(true);
    }
    expect(
      crossesChannelBoundary({
        installedVersion: "2026.9.1-beta.1",
        targetVersion: null,
        currentChannel: "beta",
        targetChannel: "beta",
      }),
    ).toBe(false);
  });

  it("accepts a missing argument object", () => {
    expect(crossesChannelBoundary()).toBe(false);
    expect(crossesChannelBoundary({})).toBe(false);
  });
});

describe("channel-boundary: channel arm details", () => {
  it("a blank persisted channel means the default (stable) channel — the caller's `?? \"stable\"`", () => {
    expect(kDefaultChannel).toBe("stable");
    for (const currentChannel of [null, undefined, "", "  "]) {
      expect(
        crossesChannelBoundary({
          installedVersion: "2026.9.2",
          targetVersion: "2026.9.3",
          currentChannel,
          targetChannel: "stable",
        }),
      ).toBe(false);
      expect(
        crossesChannelBoundary({
          installedVersion: "2026.9.2",
          targetVersion: "2026.9.3",
          currentChannel,
          targetChannel: "beta",
        }),
      ).toBe(true);
    }
  });

  it("spelling differences of one channel are not a crossing; non-strings fall back to the default", () => {
    expect(normalizeChannelName("Beta ")).toBe("beta");
    expect(normalizeChannelName("stable")).toBe("stable");
    expect(normalizeChannelName(null)).toBe("stable");
    expect(normalizeChannelName(42)).toBe("stable");
    expect(normalizeChannelName({ channel: "beta" })).toBe("stable");
    expect(
      crossesChannelBoundary({
        installedVersion: "2026.9.1-beta.1",
        targetVersion: "2026.9.1-beta.2",
        currentChannel: "Beta ",
        targetChannel: "beta",
      }),
    ).toBe(false);
  });

  it("Codex 19: reads the PERSISTED applied channel — the mutable selection would mask the crossing", () => {
    // The operator just flipped alphaclaw.json's releaseChannel to beta and
    // applies a beta build while the box still RUNS the stable apply.
    const state = { applied: { channel: "stable", version: "2026.9.2" } };
    const selection = { releaseChannel: "beta" };
    const target = { channel: "beta", version: "2026.9.2" };

    // Right provenance: persisted applied channel → this apply crosses.
    expect(
      crossesChannelBoundary({
        installedVersion: state.applied.version,
        targetVersion: target.version,
        currentChannel: state.applied?.channel ?? "stable",
        targetChannel: target.channel,
      }),
    ).toBe(true);
    // Wrong provenance: the selection already says beta → "same channel",
    // which is exactly the false negative the rule forbids.
    expect(
      crossesChannelBoundary({
        installedVersion: state.applied.version,
        targetVersion: target.version,
        currentChannel: selection.releaseChannel,
        targetChannel: target.channel,
      }),
    ).toBe(false);
    // A box that never applied anything has no applied record → stable.
    expect(
      crossesChannelBoundary({
        installedVersion: "2026.9.2",
        targetVersion: "2026.9.3-beta.1",
        currentChannel: undefined?.channel ?? "stable",
        targetChannel: "beta",
      }),
    ).toBe(true);
  });
});

describe("channel-boundary: prerelease detector parity", () => {
  // Every version shape OpenClaw publishes plus the degenerate inputs the
  // callers pass through; the shared detector must agree with BOTH twins.
  const kCorpus = [
    "2026.9.2",
    "2026.7.1-2",
    "2026.8.1-beta.3",
    "2026.9.2-beta.1",
    "2026.9.2-rc.1",
    "2026.9.2-alpha",
    "v2026.9.2",
    "v2026.9.2-beta.1",
    " 2026.9.2-beta.1 ",
    "2026.9",
    "",
    null,
    undefined,
  ];

  it("agrees with lib/server/helpers.js isPrereleaseVersion", () => {
    const server = require("../../lib/server/helpers");
    for (const version of kCorpus) {
      expect([version, isPrereleaseVersion(version)]).toEqual([
        version,
        server.isPrereleaseVersion(version),
      ]);
    }
  });

  it("agrees with the Upgrade tab's isPrereleaseVersion", async () => {
    const ui = await import(
      "../../lib/public/js/components/upgrade-tab/helpers.js"
    );
    for (const version of kCorpus) {
      expect([version, isPrereleaseVersion(version)]).toEqual([
        version,
        ui.isPrereleaseVersion(version),
      ]);
    }
  });

  it("classifies the documented shapes", () => {
    expect(isPrereleaseVersion("2026.8.1-beta.3")).toBe(true);
    expect(isPrereleaseVersion("2026.9.2-rc.1")).toBe(true);
    expect(isPrereleaseVersion("2026.7.1-2")).toBe(false);
    expect(isPrereleaseVersion("2026.9.2")).toBe(false);
    expect(isPrereleaseVersion("2026.9.2-")).toBe(false);
    expect(isPrereleaseVersion(null)).toBe(false);
  });
});

describe("channel-boundary: shared-module contract", () => {
  it("stays dependency-free so the esbuild UI bundle can import it (no require at all)", () => {
    const source = fs.readFileSync(kModulePath, "utf8");
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s/);
  });

  it("exposes the same named exports to CommonJS and ESM consumers", async () => {
    // The UI bundle imports named exports from this CJS file (the
    // update-progress-model precedent), so the static `module.exports = {…}`
    // shape must keep every name visible to an ESM importer. Behaviour, not
    // object identity, is compared: vitest's import() transform and the
    // native require() hand back distinct module instances by design.
    const esm = await import(kModulePath);
    expect(Object.keys(esm).filter((key) => key !== "default").sort()).toEqual(
      ["crossesChannelBoundary", "isPrereleaseVersion", "kDefaultChannel", "normalizeChannelName"],
    );
    expect(esm.kDefaultChannel).toBe(kDefaultChannel);
    expect(esm.normalizeChannelName(" Beta")).toBe(normalizeChannelName(" Beta"));
    for (const version of ["2026.9.2", "2026.7.1-2", "2026.9.2-beta.1", null]) {
      expect(esm.isPrereleaseVersion(version)).toBe(isPrereleaseVersion(version));
    }
    const input = {
      installedVersion: "2026.9.1-beta.1",
      targetVersion: "2026.9.2",
      currentChannel: "beta",
      targetChannel: "beta",
    };
    expect(esm.crossesChannelBoundary(input)).toBe(true);
    expect(esm.crossesChannelBoundary(input)).toBe(crossesChannelBoundary(input));
  });
});
