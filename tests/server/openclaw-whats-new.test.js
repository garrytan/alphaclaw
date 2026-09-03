const {
  resolveWhatsNew,
  minorOf,
  kWhatsNewData,
} = require("../../lib/server/openclaw-whats-new");
const { kNpmPackageRoot } = require("../../lib/server/constants");

const kBetaCatalog = {
  beta: [
    { version: "2026.8.1-beta.3" },
    { version: "2026.8.1-beta.2" },
    { version: "2026.7.2-beta.7" },
  ],
  stable: [{ version: "2026.7.1-2", isDistTagLatest: true }],
};

describe("server/openclaw-whats-new", () => {
  it("extracts the minor from full and prerelease versions", () => {
    expect(minorOf("2026.8.1-beta.3")).toBe("2026.8");
    expect(minorOf("2026.7.1-2")).toBe("2026.7");
    expect(minorOf("nonsense")).toBe(null);
  });

  it("resolves the curated beta entry for the channel's latest minor", () => {
    const resolved = resolveWhatsNew({
      catalog: kBetaCatalog,
      releaseChannel: "beta",
    });
    expect(resolved).not.toBeNull();
    expect(resolved.minor).toBe("2026.8");
    expect(resolved.channelLatest).toBe("2026.8.1-beta.3");
    expect(resolved.highlights.length).toBeGreaterThan(0);
    expect(resolved.securityFlips.length).toBeGreaterThan(0);
    // Every flip carries the admin-facing warning wording.
    for (const flip of resolved.securityFlips) {
      expect(typeof flip.key).toBe("string");
      expect(typeof flip.warning).toBe("string");
      expect(flip.warning.length).toBeGreaterThan(20);
    }
  });

  it("shows only flips that affect THIS installation (D5)", () => {
    // gateway.terminal.enabled is set explicitly → its default flip is noise
    // for this install; the other flips (unset keys) stay.
    const withExplicitKey = resolveWhatsNew({
      catalog: kBetaCatalog,
      releaseChannel: "beta",
      installedConfig: { gateway: { terminal: { enabled: false } } },
    });
    expect(
      withExplicitKey.securityFlips.some(
        (flip) => flip.key === "gateway.terminal.enabled",
      ),
    ).toBe(false);
    expect(withExplicitKey.securityFlips.length).toBeGreaterThan(0);

    // Unknown config (unreadable) keeps every flip — fail-open toward warning.
    const unknownConfig = resolveWhatsNew({
      catalog: kBetaCatalog,
      releaseChannel: "beta",
      installedConfig: null,
    });
    expect(
      unknownConfig.securityFlips.some(
        (flip) => flip.key === "gateway.terminal.enabled",
      ),
    ).toBe(true);
  });

  it("flags when the channel latest moved past the verified version", () => {
    const resolved = resolveWhatsNew({
      catalog: {
        beta: [{ version: "2026.8.9-beta.1" }],
      },
      releaseChannel: "beta",
    });
    expect(resolved).not.toBeNull();
    expect(resolved.newerThanVerified).toBe(true);
  });

  it("returns null for dev, unknown minors, and missing catalogs", () => {
    expect(resolveWhatsNew({ catalog: kBetaCatalog, releaseChannel: "dev" })).toBe(
      null,
    );
    expect(resolveWhatsNew({ catalog: null, releaseChannel: "beta" })).toBe(null);
    expect(
      resolveWhatsNew({
        catalog: { beta: [{ version: "2099.1.0-beta.1" }] },
        releaseChannel: "beta",
      }),
    ).toBe(null);
  });

  it("keeps a curated entry for the beta minor AlphaClaw currently tests against", () => {
    // Freshness guard: when the tested beta line moves to a new minor, this test
    // fails until openclaw-whats-new.json gains an entry for it. The tested beta
    // minor is derived from the entries themselves being >= the stable pin's minor.
    const pin = require(`${kNpmPackageRoot}/package.json`).dependencies.openclaw;
    const pinMinor = minorOf(pin);
    const betaEntries = kWhatsNewData.entries.filter((e) => e.channel === "beta");
    expect(betaEntries.length).toBeGreaterThan(0);
    // At least one beta entry must be for a minor >= the stable pin's minor.
    const [pinMaj, pinMin] = pinMinor.split(".").map(Number);
    const hasCurrent = betaEntries.some((entry) => {
      const [maj, min] = entry.minor.split(".").map(Number);
      return maj > pinMaj || (maj === pinMaj && min >= pinMin);
    });
    expect(hasCurrent).toBe(true);
  });
});
