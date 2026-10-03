// openclaw-channel-retirement.js: the first boot of this AlphaClaw retires
// the old in-app OpenClaw version switch ONCE (bin phase), and the server
// phase sends the one-time notice and removes the BETA/DEV Control UI stripe.
// Hermetic: real temp dirs, a fixed clock, an injected notifier.
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kRetirementFileName,
  retireReleaseChannelAtBoot,
  deliverRetirementNotice,
  formatRetirementNotice,
  isRetiredChannelStripe,
} = require("../../lib/server/openclaw-channel-retirement");
const { kBootMigrationFileName, readCompletedForVersion, writeCompletedForVersion } = require("../../lib/server/openclaw-boot-migration");

const kNow = 1_788_681_600_000;
const kPin = "2026.9.8";
const silentLogger = () => ({ log: vi.fn(), warn: vi.fn() });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const createBox = ({ state, shim = true, overlay = false } = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-channel-retirement-"));
  const managedDir = path.join(rootDir, ".openclaw", ".alphaclaw");
  fs.mkdirSync(managedDir, { recursive: true });
  const statePath = path.join(managedDir, "openclaw-channel-state.json");
  if (state !== undefined) fs.writeFileSync(statePath, typeof state === "string" ? state : `${JSON.stringify(state, null, 2)}\n`);
  const shimPath = path.join(managedDir, "bin", "openclaw");
  if (shim) {
    fs.mkdirSync(path.dirname(shimPath), { recursive: true });
    fs.writeFileSync(shimPath, "#!/bin/sh\nexec /data/openclaw-overlay/2026.9.9-beta.2/openclaw.mjs \"$@\"\n", { mode: 0o755 });
  }
  if (overlay) fs.mkdirSync(path.join(rootDir, "openclaw-overlay", "2026.9.9-beta.2"), { recursive: true });
  return { rootDir, managedDir, statePath, shimPath, recordPath: path.join(managedDir, kRetirementFileName) };
};

const kBetaState = {
  applied: { channel: "beta", version: "2026.9.9-beta.2", sha: null, at: kNow - 86_400_000 },
  pinVersion: "2026.9.3",
  configMigration: { completedForVersion: "2026.9.9-beta.2", lastAttempt: { ok: true } },
};

describe("server/openclaw-channel-retirement", () => {
  const roots = [];
  const newBox = (options) => {
    const box = createBox(options);
    roots.push(box.rootDir);
    return box;
  };
  const retire = (box, overrides = {}) =>
    retireReleaseChannelAtBoot({ managedDir: box.managedDir, rootDir: box.rootDir, pinVersion: kPin, nowFn: () => kNow, logger: silentLogger(), ...overrides });
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("retireReleaseChannelAtBoot (bin phase)", () => {
    it("a beta box: shim removed, state moved to .retired-<ts> verbatim, marker written, configMigration carried over", () => {
      const box = newBox({ state: kBetaState, overlay: true });
      const original = fs.readFileSync(box.statePath, "utf8");
      const logger = silentLogger();

      const record = retire(box, { logger });

      expect(record).toEqual({
        retiredAt: kNow,
        previous: { channel: "beta", version: "2026.9.9-beta.2", sha: null },
        pinVersion: kPin,
        overlayDir: path.join(box.rootDir, "openclaw-overlay"),
        needsNotice: true,
        notifiedAt: null,
      });
      expect(fs.existsSync(path.join(box.managedDir, "bin"))).toBe(false);
      expect(fs.existsSync(box.statePath)).toBe(false);
      expect(fs.readFileSync(`${box.statePath}.retired-${kNow}`, "utf8")).toBe(original);
      expect(readJson(box.recordPath)).toEqual(record);
      expect(readJson(path.join(box.managedDir, kBootMigrationFileName))).toEqual({ completedForVersion: "2026.9.9-beta.2", at: kNow });
      // The overlay store is left in place for the operator (the notice names it).
      expect(fs.existsSync(path.join(box.rootDir, "openclaw-overlay", "2026.9.9-beta.2"))).toBe(true);
      expect(logger.log).toHaveBeenCalledWith(
        `[alphaclaw] retired the in-app OpenClaw version switch (was beta 2026.9.9-beta.2); running the pinned ${kPin}`,
      );
    });

    it("never overwrites a boot migration record that already exists", () => {
      const box = newBox({ state: kBetaState });
      writeCompletedForVersion({ managedDir: box.managedDir, version: kPin, nowFn: () => kNow - 5 });
      retire(box);
      expect(readJson(path.join(box.managedDir, kBootMigrationFileName))).toEqual({ completedForVersion: kPin, at: kNow - 5 });
    });

    it.each([
      ["stable on the pin", { channel: "stable", version: kPin }, false],
      ["stable on an older version", { channel: "stable", version: "2026.9.2" }, false],
      ["stable on a newer version", { channel: "stable", version: "2026.10.1" }, true],
      ["a dev checkout", { channel: "dev", version: null, sha: "0123456789abcdef0123" }, true],
      ["beta", { channel: "beta", version: "2026.9.9-beta.2" }, true],
    ])("needsNotice for %s: %s", (_label, applied, needsNotice) => {
      const box = newBox({ state: { applied } });
      expect(retire(box).needsNotice).toBe(needsNotice);
    });

    it("an unreadable or applied-less state file is still moved aside, with no previous build and no notice", () => {
      const corrupt = newBox({ state: "{ torn" });
      expect(retire(corrupt)).toMatchObject({ previous: null, needsNotice: false });
      expect(fs.existsSync(corrupt.statePath)).toBe(false);
      expect(fs.readFileSync(`${corrupt.statePath}.retired-${kNow}`, "utf8")).toBe("{ torn");
      const bare = newBox({ state: { pinVersion: "2026.9.2" } });
      expect(retire(bare)).toMatchObject({ previous: null, needsNotice: false });
      expect(readCompletedForVersion({ managedDir: bare.managedDir })).toBeNull();
    });

    it("a box that never used the switch: the shim dir is still removed, nothing is recorded", () => {
      const box = newBox();
      expect(retire(box)).toBeNull();
      expect(fs.existsSync(path.join(box.managedDir, "bin"))).toBe(false);
      expect(fs.existsSync(box.recordPath)).toBe(false);
      const clean = newBox({ shim: false });
      expect(retire(clean)).toBeNull();
    });

    it("runs once: a second boot finds no state file and keeps the first marker", () => {
      const box = newBox({ state: kBetaState });
      const first = retire(box);
      expect(retire(box, { nowFn: () => kNow + 1000 })).toBeNull();
      expect(readJson(box.recordPath)).toEqual(first);
    });

    it("fails open: a marker that cannot be written costs one warning and leaves the state file for the next boot", () => {
      const box = newBox({ state: kBetaState });
      fs.mkdirSync(box.recordPath);
      const logger = silentLogger();
      expect(retire(box, { logger })).toBeNull();
      expect(fs.existsSync(box.statePath)).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not retire the OpenClaw release-channel state"));
    });
  });

  describe("deliverRetirementNotice (server phase)", () => {
    it("delivers the notice once, naming the old version and the pin, removes the stripe and stamps notifiedAt", async () => {
      const box = newBox({ state: kBetaState, overlay: true });
      retire(box);
      const notify = vi.fn(async () => {});
      const removeRetiredStripe = vi.fn(async () => {});

      await expect(
        deliverRetirementNotice({ managedDir: box.managedDir, notify, removeRetiredStripe, nowFn: () => kNow + 10_000, logger: silentLogger() }),
      ).resolves.toEqual({ delivered: true });
      expect(removeRetiredStripe).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledTimes(1);
      const [message, options] = notify.mock.calls[0];
      expect(message).toContain("OpenClaw 2026.9.9-beta.2 (beta)");
      expect(message).toContain(`pinned OpenClaw ${kPin}`);
      expect(message).toContain(`deploy an AlphaClaw release that pins OpenClaw 2026.9.9-beta.2 or newer`);
      expect(message).toContain(path.join(box.rootDir, "openclaw-overlay"));
      expect(options).toEqual({ eventType: "warning", id: `openclaw-channel-retired-${kNow}` });
      expect(readJson(box.recordPath).notifiedAt).toBe(kNow + 10_000);

      // Once: the next boot finds the record notified and does nothing.
      await expect(
        deliverRetirementNotice({ managedDir: box.managedDir, notify, removeRetiredStripe, logger: silentLogger() }),
      ).resolves.toEqual({ delivered: false });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(removeRetiredStripe).toHaveBeenCalledTimes(1);
    });

    it("a box that needs no notice still has its stripe removed and the record closed", async () => {
      const box = newBox({ state: { applied: { channel: "stable", version: kPin } } });
      retire(box);
      const notify = vi.fn();
      const removeRetiredStripe = vi.fn();
      await expect(
        deliverRetirementNotice({ managedDir: box.managedDir, notify, removeRetiredStripe, nowFn: () => kNow + 1, logger: silentLogger() }),
      ).resolves.toEqual({ delivered: false });
      expect(notify).not.toHaveBeenCalled();
      expect(removeRetiredStripe).toHaveBeenCalledTimes(1);
      expect(readJson(box.recordPath).notifiedAt).toBe(kNow + 1);
    });

    it("a notifier that throws leaves the record unnotified so the next boot retries", async () => {
      const box = newBox({ state: kBetaState });
      retire(box);
      await expect(
        deliverRetirementNotice({
          managedDir: box.managedDir,
          notify: async () => {
            throw new Error("notifier down");
          },
          logger: silentLogger(),
        }),
      ).rejects.toThrow("notifier down");
      expect(readJson(box.recordPath).notifiedAt).toBeNull();
      const notify = vi.fn(async () => {});
      await expect(deliverRetirementNotice({ managedDir: box.managedDir, notify, logger: silentLogger() })).resolves.toEqual({ delivered: true });
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("a stripe removal that throws costs one warning and never the notice", async () => {
      const box = newBox({ state: kBetaState });
      retire(box);
      const logger = silentLogger();
      const notify = vi.fn(async () => {});
      await expect(
        deliverRetirementNotice({
          managedDir: box.managedDir,
          notify,
          removeRetiredStripe: () => {
            throw new Error("config unreadable");
          },
          logger,
        }),
      ).resolves.toEqual({ delivered: true });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith("[alphaclaw] could not remove the retired BETA/DEV Control UI stripe: config unreadable");
    });

    it("no retirement record: nothing to deliver", async () => {
      const box = newBox({ shim: false });
      const notify = vi.fn();
      await expect(deliverRetirementNotice({ managedDir: box.managedDir, notify, logger: silentLogger() })).resolves.toEqual({ delivered: false });
      expect(notify).not.toHaveBeenCalled();
    });
  });

  it("formatRetirementNotice names a dev build by its short sha and omits the overlay line when there is none", () => {
    const message = formatRetirementNotice({
      retiredAt: kNow,
      previous: { channel: "dev", version: null, sha: "0123456789abcdef0123" },
      pinVersion: kPin,
      overlayDir: null,
      needsNotice: true,
    });
    expect(message).toContain("OpenClaw 0123456789ab (dev)");
    expect(message).toContain("deploy an AlphaClaw release that pins OpenClaw that version or newer");
    expect(message).not.toContain("can be deleted");
  });

  it("isRetiredChannelStripe matches only the BETA/DEV stripes the old switch wrote", () => {
    expect(isRetiredChannelStripe({ label: "BETA", color: "amber" })).toBe(true);
    expect(isRetiredChannelStripe({ label: "BETA · 2026.9.9-beta.2", color: "amber" })).toBe(true);
    expect(isRetiredChannelStripe({ label: "DEV", color: "purple" })).toBe(true);
    expect(isRetiredChannelStripe({ label: "DEV · 0123456", color: "purple" })).toBe(true);
    expect(isRetiredChannelStripe({ label: "anything", color: "red", _alphaclawManaged: true })).toBe(true);
    // An operator's own stripe stays.
    expect(isRetiredChannelStripe({ label: "STAGING", color: "amber" })).toBe(false);
    expect(isRetiredChannelStripe({ label: "BETA", color: "purple" })).toBe(false);
    expect(isRetiredChannelStripe({ label: "BETA", color: "amber", note: "mine" })).toBe(false);
    expect(isRetiredChannelStripe(null)).toBe(false);
    expect(isRetiredChannelStripe(["BETA"])).toBe(false);
  });
});
