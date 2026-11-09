const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildToolsMissingNotice,
  createToolInventory,
  kBaselineDelayMs,
  kSkillsCheckTimeoutMs,
  kSnapshotIntervalMs,
  kToolInventoryFileName,
  readContainerId,
  resolveGatewayPathDirs,
  snapshotCommands,
} = require("../../lib/server/tool-inventory");

const kRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-tool-inventory-"));
let seq = 0;
const makeDir = () => fs.mkdtempSync(path.join(kRoot, "case-" + (seq += 1) + "-"));
afterAll(() => fs.rmSync(kRoot, { recursive: true, force: true }));

const kContainerA = "a".repeat(32);
const kContainerB = "b".repeat(32);
const kContainerC = "c".repeat(32);
const kStart = Date.parse("2026-11-09T08:00:00.000Z");

const install = (dir, name, mode = 0o755) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode });
};

const makeBox = () => {
  const root = makeDir();
  const box = {
    root,
    managedDir: path.join(root, "managed"),
    usrBin: path.join(root, "usr", "bin"),
    localBin: path.join(root, "usr", "local", "bin"),
    clock: kStart,
    logs: [],
  };
  for (const name of ["git", "node", "rg", "sh"]) install(box.usrBin, name);
  box.statePath = path.join(box.managedDir, kToolInventoryFileName);
  box.readState = () => JSON.parse(fs.readFileSync(box.statePath, "utf8"));
  box.logger = {
    log: (line) => box.logs.push(line),
    warn: (line) => box.logs.push(line),
  };
  return box;
};

const createInventory = (box, containerId, overrides = {}) => {
  const timers = [];
  const notify = vi.fn(async () => ({ ok: true }));
  const runSkillsCheck = vi.fn(async () => JSON.stringify({ missingRequirements: [] }));
  const inventory = createToolInventory({
    managedDir: box.managedDir,
    containerId,
    getPathDirs: () => [box.localBin, box.usrBin],
    resolveBinDir: () => "/data/.openclaw/bin",
    runSkillsCheck,
    notify,
    now: () => box.clock,
    setTimeoutFn: (fn, ms) => {
      const timer = { fn, ms, unref: vi.fn() };
      timers.push(timer);
      return timer;
    },
    setIntervalFn: (fn, ms) => {
      const timer = { fn, ms, interval: true, unref: vi.fn() };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: () => {},
    clearIntervalFn: () => {},
    logger: box.logger,
    ...overrides,
  });
  return { inventory, timers, notify, runSkillsCheck: overrides.runSkillsCheck || runSkillsCheck };
};

// Container A serves, takes its baseline, then someone installs tree by hand
// and a 30-min tick sees it. Nothing writes a shutdown snapshot.
const runFirstContainer = async (box, { handInstalls = ["tree"] } = {}) => {
  const first = createInventory(box, kContainerA);
  await first.inventory.onGatewayReady();
  box.clock += kBaselineDelayMs;
  expect(first.inventory.recordSnapshot({ reason: "baseline" })).toMatchObject({ recorded: true });
  for (const name of handInstalls) install(box.localBin, name);
  box.clock += kSnapshotIntervalMs;
  expect(first.inventory.recordSnapshot({ reason: "tick" })).toMatchObject({ recorded: true });
  return first;
};

// The rebuild: a new container from the image, hand installs gone.
const replaceContainer = (box, { dropFromImage = [] } = {}) => {
  fs.rmSync(box.localBin, { recursive: true, force: true });
  for (const name of dropFromImage) fs.rmSync(path.join(box.usrBin, name));
  box.clock += 60_000;
};

describe("tool-inventory: container identity marker", () => {
  it("writes a random id for a new container and keeps it for the same container", () => {
    const markerPath = path.join(makeDir(), "var", "lib", "alphaclaw", "container-id");
    const env = { ALPHACLAW_CONTAINER_ID_PATH: markerPath };
    const id = readContainerId({ env, randomId: () => kContainerA });
    expect(id).toBe(kContainerA);
    expect(fs.readFileSync(markerPath, "utf8")).toBe(kContainerA + "\n");
    const randomId = vi.fn(() => kContainerB);
    expect(readContainerId({ env, randomId })).toBe(kContainerA);
    expect(randomId).not.toHaveBeenCalled();
  });

  it("replaces a marker that does not hold an id", () => {
    const markerPath = path.join(makeDir(), "container-id");
    fs.writeFileSync(markerPath, "not-an-id\n");
    expect(readContainerId({ env: { ALPHACLAW_CONTAINER_ID_PATH: markerPath }, randomId: () => kContainerB })).toBe(kContainerB);
  });

  it("turns the inventory off when the marker cannot be written, and never logs the configured path", () => {
    const dir = makeDir();
    const blocker = path.join(dir, "secret-value-xyz");
    fs.writeFileSync(blocker, "a file, not a directory");
    const logger = { warn: vi.fn() };
    expect(readContainerId({ env: { ALPHACLAW_CONTAINER_ID_PATH: path.join(blocker, "container-id") }, logger })).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/^\[alphaclaw\] tool inventory off: could not write the container marker \(E[A-Z]+\)$/);
    expect(logger.warn.mock.calls[0][0]).not.toContain("secret-value-xyz");
  });
});

describe("tool-inventory: snapshotCommands", () => {
  it("lists executable files across PATH dirs, sorted and unique, without a shell", () => {
    const root = makeDir();
    const one = path.join(root, "one");
    const two = path.join(root, "two");
    install(one, "zstd");
    install(one, "ffmpeg");
    install(two, "ffmpeg");
    install(two, "notes.txt", 0o644);
    fs.mkdirSync(path.join(two, "subdir"));
    expect(snapshotCommands([one, path.join(root, "missing"), two])).toEqual(["ffmpeg", "zstd"]);
  });

  it("returns null past its deadline, so a partial list is never recorded", () => {
    const dir = makeDir();
    install(dir, "tree");
    let clock = 0;
    expect(snapshotCommands([dir], { now: () => (clock += 1000), deadlineAt: 500 })).toBeNull();
  });

  it("never records a name that could carry markup or a line break into a notice", () => {
    const dir = makeDir();
    for (const name of ["pg_dump", "python3.12", "g++", "evil\nname", "[x](https:", "*bold*", "-flag"]) install(dir, name);
    expect(snapshotCommands([dir])).toEqual(["g++", "pg_dump", "python3.12"]);
  });

  it("reads the gateway's PATH plus the dirs OpenClaw appends for skills, without relative, empty or node_modules entries", () => {
    const dirs = resolveGatewayPathDirs({
      PATH: ["/app/node_modules/.bin", "/usr/local/bin", "", "bin", "/usr/bin"].join(path.delimiter),
      HOME: "/data",
      PNPM_HOME: "/opt/pnpm",
    });
    expect(dirs.slice(0, 3)).toEqual(["/usr/bin", "/bin", "/usr/local/bin"]);
    expect(dirs).toEqual(expect.arrayContaining([
      "/home/linuxbrew/.linuxbrew/bin",
      "/data/.linuxbrew/bin",
      "/opt/pnpm",
      "/opt/pnpm/bin",
      "/data/.local/bin",
      "/data/.npm-global/bin",
      "/data/.bun/bin",
    ]));
    expect(dirs.some((dir) => dir.includes("node_modules") || !path.isAbsolute(dir))).toBe(false);
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe("tool-inventory: baseline and snapshots", () => {
  it("takes a new container's baseline only from the first snapshot after serving", async () => {
    const box = makeBox();
    const { inventory, timers, notify } = createInventory(box, kContainerA);
    await inventory.onGatewayReady();
    expect(notify).not.toHaveBeenCalled();
    expect(box.readState()).toMatchObject({ schema: 1, containerId: kContainerA, baseline: null, latest: null, outstanding: [] });
    expect(timers.map(({ ms, interval }) => [ms, !!interval])).toEqual([[kBaselineDelayMs, false], [kSnapshotIntervalMs, true]]);
    expect(timers.every((timer) => timer.unref.mock.calls.length === 1)).toBe(true);
    expect(inventory.recordSnapshot({ reason: "tick" })).toEqual({ recorded: false, reason: "no_baseline" });
    expect(inventory.recordSnapshot({ reason: "shutdown" })).toEqual({ recorded: false, reason: "no_baseline" });
    box.clock += kBaselineDelayMs;
    timers[0].fn();
    const state = box.readState();
    expect(state.baseline).toEqual({ takenAt: new Date(box.clock).toISOString(), names: ["git", "node", "rg", "sh"] });
    expect(state.latest).toEqual(state.baseline);
    install(box.localBin, "tree");
    box.clock += kSnapshotIntervalMs;
    timers[1].fn();
    expect(box.readState().baseline.names).toEqual(["git", "node", "rg", "sh"]);
    expect(box.readState().latest.names).toEqual(["git", "node", "rg", "sh", "tree"]);
  });

  it("records the shutdown snapshot synchronously and skips it when the scan runs over budget", async () => {
    const box = makeBox();
    const { inventory } = await runFirstContainer(box);
    install(box.localBin, "yt-dlp");
    expect(inventory.recordSnapshot({ reason: "shutdown" })).toMatchObject({ recorded: true });
    expect(box.readState().latest.names).toContain("yt-dlp");
    const slow = createInventory(box, kContainerA, { now: () => (box.clock += 1000) });
    install(box.localBin, "pandoc");
    expect(slow.inventory.recordSnapshot({ reason: "shutdown" })).toEqual({ recorded: false, reason: "over_budget" });
    expect(box.readState().latest.names).not.toContain("pandoc");
  });

  it("retries a baseline that ran over budget at the next tick", async () => {
    const box = makeBox();
    let slow = false;
    const { inventory } = createInventory(box, kContainerA, { now: () => (slow ? (box.clock += 1000) : box.clock) });
    await inventory.onGatewayReady();
    box.clock += kBaselineDelayMs;
    slow = true;
    expect(inventory.recordSnapshot({ reason: "baseline" })).toEqual({ recorded: false, reason: "over_budget" });
    slow = false;
    box.clock += kSnapshotIntervalMs;
    expect(inventory.recordSnapshot({ reason: "tick" })).toMatchObject({ recorded: true });
    expect(box.readState().baseline.names).toEqual(["git", "node", "rg", "sh"]);
  });

  it("records nothing for a container whose check has not run", () => {
    const box = makeBox();
    const { inventory } = createInventory(box, kContainerA);
    expect(inventory.recordSnapshot({ reason: "shutdown" })).toEqual({ recorded: false, reason: "no_container_record" });
    expect(fs.existsSync(box.statePath)).toBe(false);
  });
});

describe("tool-inventory: the rebuild diff and notice", () => {
  it("names a lost hand install and an image-dropped tool after an unclean exit (no shutdown snapshot, no measured downtime)", async () => {
    const box = makeBox();
    await runFirstContainer(box);
    replaceContainer(box, { dropFromImage: ["rg"] });
    const next = createInventory(box, kContainerB, {
      runSkillsCheck: async () => "openclaw banner\n" + JSON.stringify({
        agentId: "main",
        missingRequirements: [
          { name: "transcribe", missing: { bins: ["tree"], anyBins: [], os: [] } },
          { name: "search", missing: { bins: [], anyBins: ["rg", "ag"], os: [] } },
          { name: "apple-notes", missing: { bins: ["tree"], anyBins: [], os: ["darwin"] } },
          { name: "[click](https://evil.example)", missing: { bins: ["tree"], anyBins: [], os: [] } },
        ],
      }),
    });
    const result = await next.inventory.onGatewayReady();
    expect(result).toEqual({ newContainer: true, lost: ["tree"], dropped: ["rg"] });
    expect(next.notify).toHaveBeenCalledTimes(1);
    const [message, opts] = next.notify.mock.calls[0];
    expect(opts).toEqual({ eventType: "deploy", id: "tools-missing-" + kContainerB });
    expect(message).toBe(
      "🧰 These tools were installed by hand inside the old container, and the redeploy removed them: tree (needed by the default agent's skills transcribe). " +
        "Ask for them to be added to the image, or put a statically linked copy in /data/.openclaw/bin.\n" +
        "🧰 The new image no longer ships: rg (needed by the default agent's skills search).",
    );
    const state = box.readState();
    expect(state).toMatchObject({ containerId: kContainerB, baseline: null, latest: null });
    expect(state.outstanding).toEqual([
      { name: "tree", kind: "hand_install_lost", missingSince: new Date(box.clock).toISOString(), containerId: kContainerB },
      { name: "rg", kind: "image_dropped", missingSince: new Date(box.clock).toISOString(), containerId: kContainerB },
    ]);
    expect(box.logs).toContain("[alphaclaw] tool inventory: new container, lost=1 dropped=1 outstanding=2");
  });

  it("sends nothing and keeps the old record when the new container's first scan runs over budget, then compares at the next start", async () => {
    const box = makeBox();
    await runFirstContainer(box);
    replaceContainer(box);
    const before = fs.readFileSync(box.statePath, "utf8");
    const slow = createInventory(box, kContainerB, { now: () => (box.clock += 1000) });
    expect(await slow.inventory.onGatewayReady()).toEqual({ newContainer: true, skipped: "over_budget" });
    expect(slow.notify).not.toHaveBeenCalled();
    expect(fs.readFileSync(box.statePath, "utf8")).toBe(before);
    expect(box.logs).toContain("[alphaclaw] tool inventory: the new container's first scan ran over budget; comparing at the next start");
    const restarted = createInventory(box, kContainerB);
    expect(await restarted.inventory.onGatewayReady()).toEqual({ newContainer: true, lost: ["tree"], dropped: [] });
    expect(restarted.notify).toHaveBeenCalledTimes(1);
  });

  it("sends nothing on a restart of the same container, even with a tool missing", async () => {
    const box = makeBox();
    await runFirstContainer(box);
    fs.rmSync(path.join(box.localBin, "tree"));
    const restarted = createInventory(box, kContainerA);
    expect(await restarted.inventory.onGatewayReady()).toEqual({ newContainer: false });
    expect(restarted.notify).not.toHaveBeenCalled();
    expect(restarted.runSkillsCheck).not.toHaveBeenCalled();
    expect(box.readState().containerId).toBe(kContainerA);
  });

  it("sends nothing and runs no skills check when the new container has everything", async () => {
    const box = makeBox();
    await runFirstContainer(box, { handInstalls: [] });
    replaceContainer(box);
    const next = createInventory(box, kContainerB);
    expect(await next.inventory.onGatewayReady()).toEqual({ newContainer: true, lost: [], dropped: [] });
    expect(next.notify).not.toHaveBeenCalled();
    expect(next.runSkillsCheck).not.toHaveBeenCalled();
  });

  it("drops names on alphaclaw.json tools.ignoreMissing", async () => {
    const box = makeBox();
    await runFirstContainer(box, { handInstalls: ["tree", "ffplay"] });
    replaceContainer(box, { dropFromImage: ["rg"] });
    const next = createInventory(box, kContainerB, { readIgnoreMissing: () => ["ffplay", "rg"] });
    expect(await next.inventory.onGatewayReady()).toMatchObject({ lost: ["tree"], dropped: [] });
    expect(next.notify.mock.calls[0][0]).not.toMatch(/ffplay|rg\b/);
  });

  it("skips the diff when the previous record is older than 7 days, keeping its outstanding names", async () => {
    const box = makeBox();
    await runFirstContainer(box);
    const state = box.readState();
    fs.writeFileSync(box.statePath, JSON.stringify({ ...state, outstanding: [{ name: "pandoc", kind: "hand_install_lost", missingSince: "2026-10-01T00:00:00.000Z", containerId: kContainerC }] }));
    replaceContainer(box);
    box.clock += 7 * 24 * 60 * 60 * 1000;
    const next = createInventory(box, kContainerB);
    expect(await next.inventory.onGatewayReady()).toEqual({ newContainer: true, lost: [], dropped: [] });
    expect(next.notify).not.toHaveBeenCalled();
    expect(box.readState().outstanding.map((entry) => entry.name)).toEqual(["pandoc"]);
    expect(box.logs).toContain("[alphaclaw] tool inventory: new container, no recent record to compare outstanding=1");
  });

  it("skips the diff for a record of another schema", async () => {
    const box = makeBox();
    await runFirstContainer(box);
    fs.writeFileSync(box.statePath, JSON.stringify({ ...box.readState(), schema: 2 }));
    replaceContainer(box);
    const next = createInventory(box, kContainerB);
    expect(await next.inventory.onGatewayReady()).toEqual({ newContainer: true, lost: [], dropped: [] });
    expect(next.notify).not.toHaveBeenCalled();
    expect(box.readState()).toMatchObject({ schema: 1, containerId: kContainerB, outstanding: [] });
  });
});

describe("tool-inventory: outstanding names", () => {
  it("keep through later snapshots and clear one by one when seen again", async () => {
    const box = makeBox();
    await runFirstContainer(box, { handInstalls: ["tree", "pandoc"] });
    replaceContainer(box);
    const next = createInventory(box, kContainerB);
    await next.inventory.onGatewayReady();
    box.clock += kBaselineDelayMs;
    next.inventory.recordSnapshot({ reason: "baseline" });
    expect(box.readState().outstanding.map((entry) => entry.name)).toEqual(["pandoc", "tree"]);
    install(box.localBin, "tree");
    box.clock += kSnapshotIntervalMs;
    next.inventory.recordSnapshot({ reason: "tick" });
    expect(box.readState().outstanding.map((entry) => entry.name)).toEqual(["pandoc"]);
    expect(next.inventory.getStatus()).toEqual({
      containerId: kContainerB,
      binDir: "/data/.openclaw/bin",
      outstanding: [expect.objectContaining({ name: "pandoc", kind: "hand_install_lost", containerId: kContainerB })],
    });
  });

  it("carry across the next redeploy without a second notice for them", async () => {
    const box = makeBox();
    await runFirstContainer(box);
    replaceContainer(box);
    const second = createInventory(box, kContainerB);
    await second.inventory.onGatewayReady();
    box.clock += kBaselineDelayMs;
    second.inventory.recordSnapshot({ reason: "baseline" });
    replaceContainer(box);
    const third = createInventory(box, kContainerC);
    expect(await third.inventory.onGatewayReady()).toEqual({ newContainer: true, lost: [], dropped: [] });
    expect(third.notify).not.toHaveBeenCalled();
    expect(box.readState().outstanding).toEqual([expect.objectContaining({ name: "tree", containerId: kContainerB })]);
  });

  it("clear when a person dismisses this container's card, and only this container's", async () => {
    const box = makeBox();
    await runFirstContainer(box);
    replaceContainer(box);
    const next = createInventory(box, kContainerB);
    await next.inventory.onGatewayReady();
    expect(next.inventory.dismissOutstanding(kContainerA)).toEqual({ cleared: 0 });
    expect(box.readState().outstanding).toHaveLength(1);
    expect(next.inventory.dismissOutstanding(kContainerB)).toEqual({ cleared: 1 });
    expect(box.readState().outstanding).toEqual([]);
    expect(next.inventory.getStatus().outstanding).toEqual([]);
  });
});

describe("tool-inventory: skills check", () => {
  const failingCases = [
    ["a timeout", () => new Promise(() => {}), "timed out after 20 s"],
    ["a non-zero exit", async () => { throw Object.assign(new Error("Command failed"), { code: 1 }); }, "exit 1"],
    ["garbage JSON", async () => "not json at all", "its output had no missingRequirements"],
  ];
  for (const [label, runSkillsCheck, why] of failingCases) {
    it("sends the notice without skill names after " + label, async () => {
      const box = makeBox();
      await runFirstContainer(box);
      replaceContainer(box);
      const next = createInventory(box, kContainerB, {
        runSkillsCheck,
        setTimeoutFn: (fn, ms) => {
          if (ms === kSkillsCheckTimeoutMs) setImmediate(fn);
          return { unref() {} };
        },
      });
      await next.inventory.onGatewayReady();
      expect(next.notify).toHaveBeenCalledTimes(1);
      expect(next.notify.mock.calls[0][0]).toBe(
        "🧰 These tools were installed by hand inside the old container, and the redeploy removed them: tree. " +
          "Ask for them to be added to the image, or put a statically linked copy in /data/.openclaw/bin.",
      );
      expect(box.logs).toContain("[alphaclaw] tool inventory: skills check failed (" + why + "); the notice goes out without skill names");
    });
  }

  it("the notice job resolves only after the skills check, so the ready hook must never await it", async () => {
    const box = makeBox();
    await runFirstContainer(box);
    replaceContainer(box);
    let release;
    const next = createInventory(box, kContainerB, { runSkillsCheck: () => new Promise((resolve) => { release = resolve; }) });
    let settled = false;
    const job = next.inventory.onGatewayReady().then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(next.notify).not.toHaveBeenCalled();
    release(JSON.stringify({ missingRequirements: [] }));
    await job;
    expect(next.notify).toHaveBeenCalledTimes(1);
  });
});

describe("tool-inventory: notice wording", () => {
  it("caps each list at 15 names, then +N more", () => {
    const names = Array.from({ length: 20 }, (_, index) => "tool" + String(index).padStart(2, "0"));
    const skills = Array.from({ length: 18 }, (_, index) => ({ name: "skill" + String(index).padStart(2, "0"), missing: { bins: ["tool00"], anyBins: [], os: [] } }));
    const message = buildToolsMissingNotice({ lost: names, dropped: [], binDir: "/srv/state/bin", skillsCheck: { missingRequirements: skills } });
    expect(message).toBe(
      "🧰 These tools were installed by hand inside the old container, and the redeploy removed them: " +
        names.slice(0, 15).join(", ") + ", +5 more (needed by the default agent's skills " + skills.slice(0, 15).map((skill) => skill.name).join(", ") + ", +3 more). " +
        "Ask for them to be added to the image, or put a statically linked copy in /srv/state/bin.",
    );
  });

  it("puts the resolved state bin dir in the advice and never an env value in the logs", async () => {
    const box = makeBox();
    await runFirstContainer(box);
    replaceContainer(box);
    const next = createInventory(box, kContainerB, { resolveBinDir: () => "/srv/custom-state/bin" });
    await next.inventory.onGatewayReady();
    expect(next.notify.mock.calls[0][0]).toContain("put a statically linked copy in /srv/custom-state/bin.");
    for (const line of box.logs) {
      expect(line).not.toContain(box.root);
      expect(line).not.toContain("/srv/custom-state");
    }
  });
});
