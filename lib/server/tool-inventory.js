// Which commands a rebuild took away (ALPH-91). A marker in the container's
// own writable layer (never on /data) tells a new container from a restart of
// the same one. The first snapshot a container takes, 2 minutes after its
// gateway first serves, is that image's baseline; later snapshots (every 30
// min and at graceful shutdown) update "latest". At the next new container,
// prev.latest - prev.baseline - now is what was installed by hand and lost,
// and prev.baseline - now is what the new image no longer ships. The owner
// hears it once per container, and the names stay outstanding (the Doctor
// card) until a snapshot sees each one again or a person dismisses the card.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("./utils/safe-file");
const { parseJsonObjectFromNoisyOutput } = require("./utils/json");

const kContainerIdDefaultPath = "/var/lib/alphaclaw/container-id";
const kContainerIdPattern = /^[a-f0-9]{32}$/;
const kToolInventoryFileName = "tool-inventory.json";
const kToolInventorySchema = 1;
const kBaselineDelayMs = 2 * 60 * 1000;
const kSnapshotIntervalMs = 30 * 60 * 1000;
const kSnapshotBudgetMs = 500;
const kStaleRecordMs = 7 * 24 * 60 * 60 * 1000;
const kSkillsCheckTimeoutMs = 20_000;
const kMaxNoticeNames = 15;
const kToolsMissingSourceKeyPrefix = "det:tools-missing:";
const kMissingKinds = Object.freeze({ HAND_INSTALL_LOST: "hand_install_lost", IMAGE_DROPPED: "image_dropped" });
const kScheduleId = "tool_inventory.snapshot";
// Names that can go into an owner notice as they are: no whitespace, no
// markup. Anything else on PATH is never recorded.
const kSafeNamePattern = /^[A-Za-z0-9][\w.+-]{0,63}$/;

// Read once at boot. A container without the marker is new and gets a random
// id; the same container keeps it across AlphaClaw restarts.
const readContainerId = ({ env = process.env, fsModule = fs, logger = console, randomId = () => crypto.randomBytes(16).toString("hex") } = {}) => {
  const markerPath = String(env.ALPHACLAW_CONTAINER_ID_PATH || "").trim() || kContainerIdDefaultPath;
  try {
    const existing = fsModule.readFileSync(markerPath, "utf8").trim();
    if (kContainerIdPattern.test(existing)) return existing;
  } catch {}
  const id = randomId();
  try {
    writeFileAtomic(markerPath, `${id}\n`, { fsModule });
    return id;
  } catch (error) {
    logger.warn?.(`[alphaclaw] tool inventory off: could not write the container marker (${error?.code || error?.message || error})`);
    return null;
  }
};

// The gateway's PATH: its env's entries, then the dirs OpenClaw appends at
// start for skills (ensureOpenClawCliOnPath in OpenClaw's src/infra/path-env.ts:
// brew, the package-manager homes and the user bin dirs under HOME). Absolute
// entries only, without node_modules dirs (a pin bump adds and drops their
// bins; nobody installs a tool there by hand).
const resolveGatewayPathDirs = (env) => {
  const home = String(env.HOME || "");
  const fromHome = (...segments) => (path.isAbsolute(home) ? path.join(home, ...segments) : "");
  const packageManagerDirs = [
    ...(env.PNPM_HOME ? [env.PNPM_HOME, path.join(env.PNPM_HOME, "bin")] : []),
    ...(env.NPM_CONFIG_PREFIX ? [path.join(env.NPM_CONFIG_PREFIX, "bin")] : []),
    env.MISE_DATA_DIR ? path.join(env.MISE_DATA_DIR, "shims") : env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "mise", "shims") : fromHome(".local", "share", "mise", "shims"),
    env.XDG_BIN_HOME || "",
  ];
  return [
    ...new Set(
      [
        "/usr/bin",
        "/bin",
        ...String(env.PATH || "").split(path.delimiter),
        fromHome(".linuxbrew", "bin"),
        fromHome(".linuxbrew", "sbin"),
        "/home/linuxbrew/.linuxbrew/bin",
        "/home/linuxbrew/.linuxbrew/sbin",
        "/usr/local/bin",
        ...packageManagerDirs,
        fromHome(".local", "bin"),
        fromHome(".npm-global", "bin"),
        fromHome(".local", "share", "pnpm", "bin"),
        fromHome(".local", "share", "pnpm"),
        fromHome(".bun", "bin"),
        fromHome(".yarn", "bin"),
      ].filter((dir) => path.isAbsolute(dir) && !dir.split(path.sep).includes("node_modules")),
    ),
  ];
};

// Sorted, unique names of the executable files directly in pathDirs. Null
// when the scan runs past deadlineAt, so a partial list is never recorded.
// Checked per entry, so one huge or slow dir cannot hold the event loop.
const snapshotCommands = (pathDirs, { fsModule = fs, now = Date.now, deadlineAt = Infinity } = {}) => {
  const names = new Set();
  for (const dir of pathDirs) {
    let entries;
    try {
      entries = fsModule.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (now() > deadlineAt) return null;
      if (names.has(name) || !kSafeNamePattern.test(name)) continue;
      try {
        const stat = fsModule.statSync(path.join(dir, name));
        if (stat.isFile() && (stat.mode & 0o111) !== 0) names.add(name);
      } catch {}
    }
  }
  return [...names].sort();
};

const asNameList = (value) => (Array.isArray(value) ? value.filter((name) => typeof name === "string" && name) : []);

const readSnapshot = (value) =>
  value && Number.isFinite(Date.parse(value.takenAt)) ? { takenAt: value.takenAt, names: asNameList(value.names) } : null;

const readOutstanding = (value) =>
  (Array.isArray(value) ? value : []).filter(
    (entry) => typeof entry?.name === "string" && Object.values(kMissingKinds).includes(entry.kind),
  );

// The previous container's losses against the names on PATH now. Null when
// its record has no baseline or is older than 7 days.
const diffPreviousContainer = ({ previous, names, ignoreMissing, nowMs }) => {
  const baseline = readSnapshot(previous.baseline);
  const latest = readSnapshot(previous.latest);
  if (!baseline || !latest || nowMs - Date.parse(latest.takenAt) > kStaleRecordMs) return null;
  const present = new Set(names);
  const ignored = new Set(ignoreMissing);
  const shipped = new Set(baseline.names);
  const missing = (list) => list.filter((name) => !present.has(name) && !ignored.has(name));
  return {
    lost: missing(latest.names.filter((name) => !shipped.has(name))),
    dropped: missing(baseline.names),
  };
};

const formatNames = (names) =>
  names.length > kMaxNoticeNames
    ? `${names.slice(0, kMaxNoticeNames).join(", ")}, +${names.length - kMaxNoticeNames} more`
    : names.join(", ");

// The default agent's skills whose missing binaries include one of names,
// leaving out skills that cannot run on this OS anyway.
const skillsNeeding = (names, skillsCheck) => {
  const wanted = new Set(names);
  return (Array.isArray(skillsCheck?.missingRequirements) ? skillsCheck.missingRequirements : [])
    .filter((entry) => kSafeNamePattern.test(String(entry?.name ?? "")) && asNameList(entry.missing?.os).length === 0)
    .filter((entry) => [...asNameList(entry.missing?.bins), ...asNameList(entry.missing?.anyBins)].some((bin) => wanted.has(bin)))
    .map((entry) => entry.name);
};

const describeNames = (names, skillsCheck) => {
  const skills = skillsNeeding(names, skillsCheck);
  return skills.length ? `${formatNames(names)} (needed by the default agent's skills ${formatNames(skills)})` : formatNames(names);
};

const buildToolsMissingNotice = ({ lost, dropped, binDir, skillsCheck = null }) => {
  const lines = [];
  if (lost.length) {
    lines.push(
      `🧰 These tools were installed by hand inside the old container, and the redeploy removed them: ${describeNames(lost, skillsCheck)}. ` +
        `Ask for them to be added to the image, or put a statically linked copy in ${binDir}.`,
    );
  }
  if (dropped.length) lines.push(`🧰 The new image no longer ships: ${describeNames(dropped, skillsCheck)}.`);
  return lines.join("\n");
};

const createToolInventory = ({
  managedDir,
  containerId,
  getPathDirs,
  readIgnoreMissing = () => [],
  resolveBinDir,
  runSkillsCheck,
  notify,
  scheduleRegistry = null,
  fsModule = fs,
  now = Date.now,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
  clearTimeoutFn = clearTimeout,
  clearIntervalFn = clearInterval,
  logger = console,
}) => {
  const filePath = path.join(managedDir, kToolInventoryFileName);
  const timers = { baseline: null, interval: null };
  let started = false;
  let baselineDueAt = Infinity;

  const read = () => {
    try {
      const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
      return parsed?.schema === kToolInventorySchema ? parsed : null;
    } catch {
      return null;
    }
  };
  const write = (state) =>
    writeFileAtomic(filePath, `${JSON.stringify({ schema: kToolInventorySchema, ...state }, null, 2)}\n`, { fsModule });
  const iso = () => new Date(now()).toISOString();
  const snapshot = () => snapshotCommands(getPathDirs(), { fsModule, now, deadlineAt: now() + kSnapshotBudgetMs });
  const ignoreList = () => {
    try {
      return asNameList(readIgnoreMissing());
    } catch {
      return [];
    }
  };

  // A container's first snapshot taken 2 minutes or more after its gateway
  // first served becomes its baseline, so a baseline attempt that failed is
  // retried by the next tick; before that, nothing is recorded. Synchronous
  // and capped, so the shutdown snapshot never delays the gateway stop.
  const recordSnapshot = ({ reason = "tick" } = {}) => {
    try {
      const state = read();
      if (!containerId || state?.containerId !== containerId) return { recorded: false, reason: "no_container_record" };
      const baseline = readSnapshot(state.baseline);
      if (!baseline && now() < baselineDueAt) return { recorded: false, reason: "no_baseline" };
      const names = snapshot();
      if (!names) return { recorded: false, reason: "over_budget" };
      const taken = { takenAt: iso(), names };
      const present = new Set(names);
      const outstanding = readOutstanding(state.outstanding).filter((entry) => !present.has(entry.name));
      write({ containerId, baseline: baseline || taken, latest: taken, outstanding });
      return { recorded: true, names: names.length, outstanding: outstanding.length };
    } catch (error) {
      logger.warn?.(`[alphaclaw] tool inventory snapshot (${reason}) failed: ${error?.code || error?.message || error}`);
      return { recorded: false, reason: "error" };
    }
  };

  const readSkillsCheck = async () => {
    let timer = null;
    try {
      const raw = await Promise.race([
        runSkillsCheck(),
        new Promise((_, reject) => {
          timer = setTimeoutFn(() => reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), kSkillsCheckTimeoutMs);
        }),
      ]);
      const parsed = parseJsonObjectFromNoisyOutput(raw);
      if (!Array.isArray(parsed?.missingRequirements)) throw new Error("its output had no missingRequirements");
      return parsed;
    } catch (error) {
      const why = error?.code === "ETIMEDOUT"
        ? `timed out after ${kSkillsCheckTimeoutMs / 1000} s`
        : Number.isInteger(error?.code) ? `exit ${error.code}` : error?.message || String(error);
      logger.warn?.(`[alphaclaw] tool inventory: skills check failed (${why}); the notice goes out without skill names`);
      return null;
    } finally {
      clearTimeoutFn(timer);
    }
  };

  // A process that finds its own container's record is a restart of the same
  // container: no diff, no notice. The notice goes out before the record is
  // written, so a crash in between re-sends under the same outbox id.
  const checkContainer = async () => {
    const previous = read();
    if (previous?.containerId === containerId) return { newContainer: false };
    const names = snapshot();
    if (!names) {
      logger.warn?.("[alphaclaw] tool inventory: the new container's first scan ran over budget; comparing at the next start");
      return { newContainer: true, skipped: "over_budget" };
    }
    const diff = previous ? diffPreviousContainer({ previous, names, ignoreMissing: ignoreList(), nowMs: now() }) : null;
    const present = new Set(names);
    const carried = previous ? readOutstanding(previous.outstanding).filter((entry) => !present.has(entry.name)) : [];
    const known = new Set(carried.map((entry) => entry.name));
    const lost = diff?.lost ?? [];
    const dropped = diff?.dropped ?? [];
    const missingSince = iso();
    const found = [
      ...lost.map((name) => ({ name, kind: kMissingKinds.HAND_INSTALL_LOST })),
      ...dropped.map((name) => ({ name, kind: kMissingKinds.IMAGE_DROPPED })),
    ]
      .filter((entry) => !known.has(entry.name))
      .map((entry) => ({ ...entry, missingSince, containerId }));
    logger.log?.(
      `[alphaclaw] tool inventory: new container, ${diff ? `lost=${lost.length} dropped=${dropped.length}` : "no recent record to compare"} outstanding=${carried.length + found.length}`,
    );
    if (lost.length || dropped.length) {
      const skillsCheck = await readSkillsCheck();
      await Promise.resolve()
        .then(() => notify(buildToolsMissingNotice({ lost, dropped, binDir: resolveBinDir(), skillsCheck }), {
          eventType: "deploy",
          id: `tools-missing-${containerId}`,
        }))
        .catch(() => {});
    }
    write({ containerId, baseline: null, latest: null, outstanding: [...carried, ...found] });
    return { newContainer: true, lost, dropped };
  };

  const startSnapshots = () => {
    const tracked = (reason) =>
      scheduleRegistry
        ? scheduleRegistry.track(kScheduleId, () => recordSnapshot({ reason }), (result) => ({ outcome: result.recorded ? "ok" : "skipped", detail: result.reason || null }))
        : recordSnapshot({ reason });
    scheduleRegistry?.define(kScheduleId, {
      title: "Snapshot of the commands on the gateway's PATH, for the rebuild notice",
      schedule: `every ${Math.round(kSnapshotIntervalMs / 60000)} min`,
      intervalMs: kSnapshotIntervalMs,
    });
    scheduleRegistry?.setActive(kScheduleId, true);
    baselineDueAt = now() + kBaselineDelayMs;
    timers.baseline = setTimeoutFn(() => tracked("baseline"), kBaselineDelayMs);
    timers.interval = setIntervalFn(() => tracked("tick"), kSnapshotIntervalMs);
    timers.baseline?.unref?.();
    timers.interval?.unref?.();
  };

  // The notice job: started with setImmediate from the gateway-ready hook and
  // never awaited there. Runs once per process.
  const onGatewayReady = async () => {
    if (!containerId || started) return null;
    started = true;
    let result = null;
    try {
      result = await checkContainer();
    } catch (error) {
      logger.warn?.(`[alphaclaw] tool inventory check failed: ${error?.code || error?.message || error}`);
    }
    startSnapshots();
    return result;
  };

  const getStatus = () => {
    const state = read();
    if (!containerId || state?.containerId !== containerId) return null;
    return { containerId, binDir: resolveBinDir(), outstanding: readOutstanding(state.outstanding) };
  };

  // A person dismissed this container's card: forget its names.
  const dismissOutstanding = (cardContainerId) => {
    const state = read();
    if (!containerId || cardContainerId !== containerId || state?.containerId !== containerId) return { cleared: 0 };
    write({ ...state, outstanding: [] });
    return { cleared: readOutstanding(state.outstanding).length };
  };

  const stop = () => {
    clearTimeoutFn(timers.baseline);
    clearIntervalFn(timers.interval);
    timers.baseline = null;
    timers.interval = null;
    scheduleRegistry?.setActive(kScheduleId, false);
  };

  return { onGatewayReady, recordSnapshot, getStatus, dismissOutstanding, stop };
};

module.exports = {
  buildToolsMissingNotice,
  createToolInventory,
  kBaselineDelayMs,
  kContainerIdDefaultPath,
  kMissingKinds,
  kSkillsCheckTimeoutMs,
  kSnapshotIntervalMs,
  kToolInventoryFileName,
  kToolsMissingSourceKeyPrefix,
  readContainerId,
  resolveGatewayPathDirs,
  snapshotCommands,
};
