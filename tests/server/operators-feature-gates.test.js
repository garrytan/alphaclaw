const fs = require("fs");
const os = require("os");
const path = require("path");

const { createOperatorsStore } = require("../../lib/server/operators-store");
const {
  createFeatureGates,
  kFeatureMinVersions,
} = require("../../lib/server/openclaw-feature-gates");

const kSilentLogger = { log() {}, warn() {}, error() {} };

const mkTemp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe("server/operators-store", () => {
  const makeStore = () =>
    createOperatorsStore({
      openclawDir: mkTemp("operators-store-test-"),
      logger: kSilentLogger,
    });

  it("normalizes operators and rejects malformed ids", () => {
    const store = makeStore();
    store.setOperators([
      { id: "Garry", name: "Garry", email: "g@example.com" },
      { id: "../evil", name: "nope" },
      { id: "ok-2", name: "" },
    ]);
    const { operators } = store.read();
    expect(operators.map((op) => op.id)).toEqual(["garry", "ok-2"]);
    expect(operators[1].name).toBe("ok-2");
  });

  it("bumps operatorsVersion on removal only (cookie revocation hook)", () => {
    const store = makeStore();
    store.setOperators([{ id: "a", name: "A" }]);
    const v1 = store.read().operatorsVersion;
    store.setOperators([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]);
    expect(store.read().operatorsVersion).toBe(v1);
    store.setOperators([{ id: "b", name: "B" }]);
    expect(store.read().operatorsVersion).toBe(v1 + 1);
  });

  it("stores the PII file with 0600 permissions", () => {
    const store = makeStore();
    store.setOperators([{ id: "a", name: "A", email: "a@example.com" }]);
    const mode = fs.statSync(store.storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("normalizes notification prefs and drops unsupported channels", () => {
    const store = makeStore();
    store.setNotificationPrefs({
      preferredChannel: "TELEGRAM",
      adminTargets: [
        { channel: "telegram", target: " 123 " },
        { channel: "carrier-pigeon", target: "coo" },
        { channel: "slack", target: "" },
      ],
    });
    const { notifications } = store.read();
    expect(notifications.preferredChannel).toBe("telegram");
    expect(notifications.adminTargets).toEqual([
      { channel: "telegram", target: "123", accountId: null },
    ]);
  });

  it("reads an absent or corrupted file as empty defaults", () => {
    const dir = mkTemp("operators-store-corrupt-");
    fs.mkdirSync(path.join(dir, ".alphaclaw"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".alphaclaw", "operators.json"), "{nope");
    const store = createOperatorsStore({
      openclawDir: dir,
      logger: kSilentLogger,
    });
    expect(store.read()).toEqual(
      expect.objectContaining({ operators: [], operatorsVersion: 1 }),
    );
  });
});

describe("server/openclaw-feature-gates", () => {
  const gatesFor = (version) =>
    createFeatureGates({ getInstalledVersion: () => version });

  it("gates beta features on the 2026.8.1 prerelease line", () => {
    expect(gatesFor("2026.7.1-2").supportsFeature("multiUser")).toBe(false);
    expect(gatesFor("2026.8.1-beta.1").supportsFeature("multiUser")).toBe(true);
    expect(gatesFor("2026.8.1-beta.3").supportsFeature("sqliteBackup")).toBe(
      true,
    );
    expect(gatesFor("2026.8.1").supportsFeature("supervisorMode")).toBe(true);
  });

  it("trustedProxyAuth is available on the current stable", () => {
    expect(gatesFor("2026.7.1-2").supportsFeature("trustedProxyAuth")).toBe(
      true,
    );
    expect(gatesFor("2026.6.34").supportsFeature("trustedProxyAuth")).toBe(
      false,
    );
  });

  it("fails closed: unknown feature, null version, dev shas, throwing reader", () => {
    expect(gatesFor("2026.9.1").supportsFeature("nonexistent")).toBe(false);
    expect(gatesFor(null).supportsFeature("multiUser")).toBe(false);
    expect(
      gatesFor("a1b2c3d4e5f6a7b8c9d0").supportsFeature("multiUser"),
    ).toBe(false);
    const throwing = createFeatureGates({
      getInstalledVersion: () => {
        throw new Error("boom");
      },
    });
    expect(throwing.supportsFeature("multiUser")).toBe(false);
  });

  it("features() maps every known feature", () => {
    const { features, version } = gatesFor("2026.8.1-beta.3").features();
    expect(version).toBe("2026.8.1-beta.3");
    expect(Object.keys(features).sort()).toEqual(
      Object.keys(kFeatureMinVersions).sort(),
    );
    expect(Object.values(features).every((v) => typeof v === "boolean")).toBe(
      true,
    );
  });
});
