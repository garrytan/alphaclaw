const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  applyResourceAutotune,
  resetAutotuneForTests,
} = require("../../lib/server/autotune");
const {
  resetMachineProfileForTests,
} = require("../../lib/server/machine-profile");
const { actionsForState } = require("../../lib/server/gateway-state");

const kMb = 1024 * 1024;
const kGb = 1024 * kMb;

// fs-spy cgroup fixtures (same pattern as autotune.test.js — extraction into a
// shared helper is tracked in TODOS.md).
const spyCgroupFiles = (files) => {
  const realReadFileSync = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
    const key = String(filePath);
    if (key.startsWith("/sys/fs/cgroup")) {
      if (Object.prototype.hasOwnProperty.call(files, key)) return files[key];
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return realReadFileSync(filePath, ...args);
  });
};

const containerFsModule = {
  existsSync: (p) => String(p) === "/.dockerenv",
  readFileSync: () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
};

const setLiveProfile = ({ memMb, cores, diskGb = 40 }) => {
  vi.restoreAllMocks();
  spyCgroupFiles({
    "/sys/fs/cgroup/memory.max": `${memMb * kMb}\n`,
    "/sys/fs/cgroup/cpu.max": `${Math.round(cores * 100000)} 100000`,
  });
  vi.spyOn(fs, "statfsSync").mockReturnValue({
    bsize: 4096,
    blocks: (diskGb * kGb) / 4096,
    bfree: ((diskGb / 2) * kGb) / 4096,
  });
  resetMachineProfileForTests({ fsModule: containerFsModule });
};

const makeConfigStore = (initial = {}) => {
  const store = { config: initial };
  const fn = vi.fn(({ mutate }) => {
    const result = mutate(store.config) || {};
    return { config: store.config, ...result };
  });
  return { store, fn };
};

const makeTempDirs = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-notify-test-"));
  const openclawDir = path.join(base, ".openclaw");
  const managedDir = path.join(openclawDir, ".alphaclaw");
  fs.mkdirSync(managedDir, { recursive: true });
  return { base, openclawDir, managedDir };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("server/auto-fix notifications — autotune composition", () => {
  it("announces a first-time concurrency adoption once, with a stable id — and stays silent on an unchanged reapply", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 8192, cores: 4 });
    resetAutotuneForTests({ managedDir });
    const { fn } = makeConfigStore({});
    const notify = vi.fn();

    await applyResourceAutotune({
      trigger: "boot",
      deps: { env: {}, openclawDir, updateOpenclawConfigFn: fn, notify },
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message).toBe(
      "Autotune set agents.defaults.maxConcurrent to 32 in openclaw.json (was unset).",
    );
    expect(opts.eventType).toBe("autotune");
    // Day-bucketed stable id: boot loops within a day dedupe in the outbox.
    expect(opts.id).toMatch(/^autotune-concurrency-unset-32-\d{8}$/);

    // Unchanged reapply: no persisted value moved — never an every-boot spam.
    notify.mockClear();
    await applyResourceAutotune({
      trigger: "reapply",
      deps: { env: {}, openclawDir, updateOpenclawConfigFn: fn, notify },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("announces the disable revert that deletes an autotune-adopted value", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 8192, cores: 4 });
    resetAutotuneForTests({ managedDir });
    const { fn } = makeConfigStore({});
    const notify = vi.fn();

    await applyResourceAutotune({
      trigger: "boot",
      deps: { env: {}, openclawDir, updateOpenclawConfigFn: fn, notify },
    });
    notify.mockClear();

    // Env kill-switch: the adopted-from-absent key is deleted (revert).
    await applyResourceAutotune({
      trigger: "reapply",
      deps: {
        env: { ALPHACLAW_AUTOTUNE_DISABLED: "1" },
        openclawDir,
        updateOpenclawConfigFn: fn,
        notify,
      },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain(
      "Autotune disabled — agents.defaults.maxConcurrent restored to the default",
    );
    expect(notify.mock.calls[0][1].id).toMatch(
      /^autotune-concurrency-32-default-\d{8}$/,
    );
  });

  it("announces the disable revert that clamps an autotune-written >64 value", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 8192, cores: 4 });
    // Seed a ledger that attributes a 96 boot default to autotune's own
    // confirmed write (only attributable values may be clamped on disable).
    fs.writeFileSync(
      path.join(managedDir, "autotune-ledger.json"),
      JSON.stringify({
        version: 1,
        ownedKeys: {
          "agents.defaults.maxConcurrent": {
            ownedFromAbsent: false,
            lastApplied: 96,
          },
        },
      }),
      "utf8",
    );
    resetAutotuneForTests({ managedDir });
    const { fn } = makeConfigStore({
      agents: { defaults: { maxConcurrent: 96 } },
    });
    const notify = vi.fn();

    await applyResourceAutotune({
      trigger: "reapply",
      deps: {
        env: { ALPHACLAW_AUTOTUNE_DISABLED: "1" },
        openclawDir,
        updateOpenclawConfigFn: fn,
        notify,
      },
    });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain(
      "clamped back to 64 (was 96)",
    );
    expect(notify.mock.calls[0][1].id).toMatch(
      /^autotune-concurrency-96-64-\d{8}$/,
    );
  });

  it("announces a crash-window recovered write even when the value already matches", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 8192, cores: 4 });
    // A stale intent whose value matches the config: OUR write landed but
    // the confirm (and its announcement) died with a crash.
    fs.writeFileSync(
      path.join(managedDir, "autotune-ledger.json"),
      JSON.stringify({
        version: 1,
        ownedKeys: {
          "agents.defaults.maxConcurrent": {
            intent: { value: 32, at: 1 },
          },
        },
      }),
      "utf8",
    );
    resetAutotuneForTests({ managedDir });
    const { fn } = makeConfigStore({
      agents: { defaults: { maxConcurrent: 32 } },
    });
    const notify = vi.fn();

    await applyResourceAutotune({
      trigger: "boot",
      deps: { env: {}, openclawDir, updateOpenclawConfigFn: fn, notify },
    });

    const confirmCall = notify.mock.calls.find(([message]) =>
      String(message).includes("Autotune confirmed"),
    );
    expect(confirmCall).toBeTruthy();
    expect(confirmCall[0]).toContain("written just before a restart");
  });

  it("folds the concurrency delta into ONE resize notification and uses the urgent downsize copy", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 8192, cores: 4 });
    resetAutotuneForTests({ managedDir });
    const { fn } = makeConfigStore({});
    const notify = vi.fn();

    await applyResourceAutotune({
      trigger: "boot",
      deps: { env: {}, openclawDir, updateOpenclawConfigFn: fn, notify },
    });
    notify.mockClear();

    // Container shrinks 8GB→2GB and 4→2 cores: downsize branch + retuned
    // concurrency, in one composed message (never two alerts for one resize).
    setLiveProfile({ memMb: 2048, cores: 2 });
    await applyResourceAutotune({
      trigger: "resize",
      refreshProfile: true,
      deps: { env: {}, openclawDir, updateOpenclawConfigFn: fn, notify },
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message).toContain("⚠️ Container downsized");
    expect(message).toContain("memory 8GB→2GB");
    expect(message).toContain("Watch for OOM pressure");
    expect(message).toContain("Autotune set agents.defaults.maxConcurrent");
    expect(opts.id).toMatch(/^autotune-retune-.+-\d{8}$/);
  });

  it("uses the neutral copy on growth", async () => {
    const { openclawDir, managedDir } = makeTempDirs();
    setLiveProfile({ memMb: 2048, cores: 2 });
    resetAutotuneForTests({ managedDir });
    const { fn } = makeConfigStore({});
    const notify = vi.fn();

    await applyResourceAutotune({
      trigger: "boot",
      deps: { env: {}, openclawDir, updateOpenclawConfigFn: fn, notify },
    });
    notify.mockClear();

    // Growth only (no dimension shrinks): neutral copy, no urgency.
    setLiveProfile({ memMb: 8192, cores: 4 });
    await applyResourceAutotune({
      trigger: "resize",
      refreshProfile: true,
      deps: { env: {}, openclawDir, updateOpenclawConfigFn: fn, notify },
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const [message] = notify.mock.calls[0];
    expect(message).toContain("Container resized");
    expect(message).not.toContain("⚠️");
    expect(message).not.toContain("downsized");
  });
});

describe("server/auto-fix notifications — reconciler notice contracts", () => {
  // Source-shape drift-guards for the boot-reconciler notices: the reconciler
  // itself is exercised end-to-end by the channel journey/boot e2e suites
  // (heavyweight fixtures); these pin the notification contracts — the
  // condition, the id shape, and the stable-id rule — so a refactor can't
  // silently drop or timestamp them.
  const channelSyncSource = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "lib",
      "server",
      "openclaw-channel-sync.js",
    ),
    "utf8",
  );

  it("the successful automatic doctor migration notifies once per from→to episode", () => {
    // Fires ONLY when the doctor actually ran and succeeded — never on plain
    // no-migration boots.
    expect(channelSyncSource).toContain(
      "if (doctorRan && doctorOutcome?.ok === true) {",
    );
    expect(channelSyncSource).toContain(
      "OpenClaw automatic repair completed for ${installedVersion}",
    );
    expect(channelSyncSource).toContain(
      "id: `db-migrated-${fromVersion}-${installedVersion}`",
    );
  });

  it("the machinery-error gateway hold notifies with a failure-signature id", () => {
    expect(channelSyncSource).toContain(
      "The gateway is HELD to protect your data",
    );
    expect(channelSyncSource).toContain(
      "id: `reconcile-machinery-hold-${installedVersion}-${notifyReasonHash(reason)}`",
    );
  });

  it("quarantine recovery notifies with a day-bucketed id", () => {
    expect(channelSyncSource).toContain(
      "stranded openclaw.json.last-good file(s) from an interrupted repair",
    );
    expect(channelSyncSource).toContain(
      "id: `quarantine-recovered-${notifyDayBucket()}`",
    );
    // Guarded on an actual recovery — a clean boot stays silent.
    expect(channelSyncSource).toContain("if (quarantine?.recovered > 0) {");
  });
});

describe("server/auto-fix notifications — E5 action-vocabulary parity", () => {
  it("the crash-loop paused copy names the down state's catalog actions verbatim", () => {
    // TODOS.md "Notification remediation-action parity": alert copy naming a manual
    // remediation must use the SAME labels as the gateway card's actions[].
    // A crash-looping gateway with restarts paused is port-down → state
    // `down`: Retry primary, Repair secondary.
    const actions = actionsForState("down", {});
    const primary = actions.find((a) => a.kind === "primary");
    const repair = actions.find((a) => a.id === "repair");
    expect(primary.label).toBe("Retry");
    expect(repair.label).toBe("Repair");

    const watchdogSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "lib", "server", "watchdog.js"),
      "utf8",
    );
    const pausedCopy = watchdogSource.match(
      /Automatic gateway restart paused; manual action required[^"]*/,
    );
    expect(pausedCopy).toBeTruthy();
    expect(pausedCopy[0]).toContain(`use ${primary.label}`);
    expect(pausedCopy[0]).toContain(`(or ${repair.label})`);
  });

  it("the auto-restarting went-down copy stays action-free (no manual CTA while retrying)", () => {
    const watchdogSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "lib", "server", "watchdog.js"),
      "utf8",
    );
    const downCopy = watchdogSource.match(/🔴 Gateway went down[^`]*/);
    expect(downCopy).toBeTruthy();
    expect(downCopy[0]).toContain("AlphaClaw will retry automatically");
    // Naming "Retry"/"Repair" here would contradict the notice's own text.
    expect(downCopy[0]).not.toContain("Retry from");
    expect(downCopy[0]).not.toContain("Repair from");
  });
});
