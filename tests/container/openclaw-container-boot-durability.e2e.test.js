// vitest globals (describe/test/expect/hooks) are on via vitest.config.js.
const fs = require("node:fs");
const path = require("node:path");
const {
  describeContainer,
  repoRoot,
  ensureArtifactsDir,
  assertDockerAvailable,
  buildImage,
  createVolume,
  seedVolume,
  runContainer,
  getMappedPort,
  execInContainer,
  containerLogs,
  removeContainer,
  removeVolume,
  waitFor,
  loginForCookie,
  fetchJsonWithCookie,
} = require("./container-helpers.js");

// -----------------------------------------------------------------------------
// Container E2E: boot durability of the boot spine (issue #76, plan
// "Regression tests for #76" item 7 + Eng "Codex 21").
//
// The 2026-09-06 incident's first root cause (RC1) was a legacy pidfile
// `{ pid, at }` whose pid happened to name a THREAD of the new container's own
// node process: kill(pid, 0) succeeded, the argv check read the thread
// leader's command line, and every boot concluded "another AlphaClaw owns the
// state dir" — skipping the sync that would have activated the recorded build.
// This leg reproduces the mechanism deterministically instead of hoping for a
// pid collision:
//
//   container A boots once ─▶ verify its real server/thread identity
//        ▼
//   remove A; seed the volume with the old legacy claim and arm a test preload
//        + a `running` ledger run + a `running` restart operation from a
//        foreign bootId + a `.tmp` archive in the backups dir
//        ▼
//   container B's test-only preload plants a legacy claim naming B's own
//   REAL nonleader TID immediately before the unchanged boot spine runs.
//   No assumption about PID allocation surviving replacement; no mocked /proc.
//   boot-report.json must say:
//     - pidfile decision `proceed`, reason `own_thread` | `thread` — the Tgid
//       rule fired (the mechanism, not just "boot succeeded")
//     - the installed tree is the recorded build (no installed_not_expected)
//       and the verdict is empty (consistent)
//     - the dangling run was closed (`danglingRecords.closedRuns`)
//   and on the volume:
//     - alphaclaw-server.pid is B's own format-2 claim
//     - the restart operation is `interrupted`
//     - the `.tmp` archive is gone (Stage 4's boot sweep; asserted only when
//       the sweep has landed — see kSweepLanded)
//   and the gateway is healthy.
//
// Opt-in via OPENCLAW_CONTAINER_E2E=1 (npm run test:container). Requires a
// running docker daemon with outbound network (the image install pulls the
// pinned OpenClaw). ~10-20 min end to end. The separate true self-upgrade
// journey lives in alphaclaw-container-self-upgrade.e2e.test.js; keep this
// same-image drill with deterministic injection of the actual thread-ID collision.
// -----------------------------------------------------------------------------

const kRunId = Date.now().toString(36);
const kImageTag = `alphaclaw-container-boot-e2e:${kRunId}`;
const kVolume = `alphaclaw-boot-e2e-data-${kRunId}`;
const kContainerA = `alphaclaw-boot-e2e-${kRunId}`;
const kContainerB = `alphaclaw-boot-e2e-${kRunId}-fresh`;
const kSetupPassword = "container-boot-e2e-pass";
const kGatewayToken = "container-boot-e2e-token";
const kGatewayPort = 18789;
const kMin = 60 * 1000;

// On-volume paths (ALPHACLAW_ROOT_DIR=/data in the image): the managed dir is
// <openclawDir>/.alphaclaw (openclaw-release-channel.js kManagedDirName); the
// restart operation lives beside the flag file in the state dir
// (restart-required-state.js); backups under <root>/backups/openclaw
// (constants.kOpenclawBackupsDir).
const kOpenclawDir = "/data/.openclaw";
const kManagedDir = `${kOpenclawDir}/.alphaclaw`;
const kServerPidPath = `${kManagedDir}/alphaclaw-server.pid`;
const kBootReportPath = `${kManagedDir}/boot-report.json`;
const kRunsDir = `${kManagedDir}/runs`;
const kRestartOperationPath = `${kOpenclawDir}/alphaclaw-restart-operation.json`;
const kBackupsDir = "/data/backups/openclaw";
const kThreadFixtureDir = "/data/boot-tid-fixture";
const kThreadPreloadPath = `${kThreadFixtureDir}/preload.cjs`;
const kThreadArmedPath = `${kThreadFixtureDir}/armed.json`;
const kThreadWitnessPath = `${kThreadFixtureDir}/witness.json`;
// A crypto.randomUUID()-shaped operationId (the ledger refuses anything else).
const kDanglingRunId = "0f76b007-e2e0-4c0d-9a1e-000000000076";
const kInterruptedRestartId = "0f76b007-e2e0-4c0d-9a1e-000000000079";
// The pre-apply backup's temp naming: `<archive>.<uuid>.tmp` beside the
// archive it would have become (openclaw-backup-offline-copy.js).
const kTmpArchiveName =
  "openclaw-backup-2026-09-06T15-00-00.alphaclaw.tar.gz.0f76b007-e2e0-4c0d-9a1e-000000000054.tmp";
// A legacy claim older than any plausible container start: two days.
const kLegacyClaimAgeMs = 2 * 24 * 60 * 60 * 1000;
// Stage 4(g) lands the boot `.tmp` sweep; until it is in the tree the seeded
// temp survives the boot and this leg records that instead of failing.
// Detected from the source so the assertion turns on by itself.
const kSweepLanded = /sweepBackupDebris/.test(
  fs.readFileSync(path.join(repoRoot, "lib", "server", "openclaw-channel-sync.js"), "utf8"),
);
const kServerPidFormat = 2;
const kThreadReasons = ["own_thread", "thread"];

// The seeded stable-accepted config — the same shape the upgrade journey
// verified against the pinned stable gateway (loopback, fixed port, token).
const buildSeedConfig = () => ({
  gateway: {
    mode: "local",
    bind: "loopback",
    port: kGatewayPort,
    auth: { token: kGatewayToken },
  },
});

const containerEnv = () => {
  const env = {
    SETUP_PASSWORD: kSetupPassword,
    OPENCLAW_GATEWAY_TOKEN: kGatewayToken,
  };
  if (process.env.GITHUB_TOKEN) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  return env;
};

// ---------------------------------------------------------------------------
// Shared journey state: one ordered journey, each step carries it forward.
// ---------------------------------------------------------------------------
const ctx = {
  stablePin: null,
  port: null,
  cookie: null,
  serverPidA: null,
  threadIdA: null,
  threadWitnessB: null,
  activeContainer: kContainerA,
  bootReportB: null,
};

// A broken step poisons every later step (they cannot mean anything); the
// failure names the step that broke instead of green-lying.
let journeyBroken = null;

const step = (name, timeoutMs, fn) => {
  // retry: 0 — re-running a mid-journey step (re-seeding, re-booting) is
  // never safe, and a broken journey must fail deterministically.
  test(name, { timeout: timeoutMs, retry: 0 }, async () => {
    if (journeyBroken) {
      throw new Error(`journey already broken at step "${journeyBroken}" — cannot run "${name}"`);
    }
    try {
      await fn();
    } catch (err) {
      journeyBroken = name;
      throw err;
    }
  });
};

const baseUrl = () => `http://127.0.0.1:${ctx.port}`;

// Cookie-carrying status poll that survives session resets across container
// replacements: re-login once on any auth failure, then retry the read.
const readStatus = async () => {
  const attempt = async () => fetchJsonWithCookie(`${baseUrl()}/api/status`, ctx.cookie);
  try {
    if (!ctx.cookie) throw new Error("no session yet");
    return await attempt();
  } catch {
    ctx.cookie = await loginForCookie(baseUrl(), kSetupPassword);
    return attempt();
  }
};

const gatewayHealthzOk = async (container) => {
  try {
    await execInContainer(container, ["curl", "-fsS", `http://127.0.0.1:${kGatewayPort}/healthz`]);
    return true;
  } catch {
    return false;
  }
};

const waitForUiUp = async (container, timeoutMs) => {
  await waitFor(
    async () => {
      ctx.port = await getMappedPort(container);
      const res = await fetch(`${baseUrl()}/login.html`, { headers: { Accept: "text/html" } });
      return res.status === 200;
    },
    { timeoutMs, intervalMs: 2000, label: `login page 200 on ${container}` },
  );
};

// /api/status reports "2026.7.1-2 (0790d9f)" — version + build sha.
const versionMatches = (reported, expected) =>
  typeof reported === "string" && (reported === expected || reported.startsWith(`${expected} `));

const waitForVersion = async (container, version, timeoutMs) => {
  await waitFor(
    async () => {
      ctx.port = await getMappedPort(container);
      const status = await readStatus();
      return versionMatches(status.openclawVersion, version);
    },
    { timeoutMs, intervalMs: 3000, label: `/api/status openclawVersion matches ${version} on ${container}` },
  );
};

const readJsonInContainer = async (container, file) => {
  const { stdout } = await execInContainer(container, ["cat", file]);
  return JSON.parse(stdout);
};

const fileExistsInContainer = async (container, file) =>
  execInContainer(container, ["test", "-e", file])
    .then(() => true)
    .catch(() => false);

// Every thread of a process, as integers, leader first. procps is in the
// image but /proc needs no tool: `ls /proc/<pid>/task` is the kernel's list.
const readThreadIds = async (container, pid) => {
  const { stdout } = await execInContainer(container, ["ls", `/proc/${pid}/task`]);
  return stdout
    .split(/\s+/)
    .map((token) => Number(token))
    .filter((tid) => Number.isInteger(tid) && tid > 0)
    .sort((a, b) => a - b);
};

describeContainer("container E2E: boot durability — legacy pidfile TID collision, dangling records, .tmp debris", () => {
  beforeAll(async () => {
    await assertDockerAvailable();
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    ctx.stablePin = pkg.dependencies.openclaw;
    expect(ctx.stablePin).toBeTruthy();
    console.log(`[container-boot-e2e] stable pin ${ctx.stablePin}; .tmp sweep ${kSweepLanded ? "landed — asserted" : "not in tree — recorded only"}`);
  }, 2 * kMin);

  afterAll(async () => {
    // Preserve evidence before teardown when the journey broke: both
    // containers' logs (deep tail — a restart loop scrolls a first boot out
    // fast) and B's boot report when it exists.
    try {
      if (journeyBroken) {
        const dir = ensureArtifactsDir();
        for (const name of [kContainerA, kContainerB]) {
          try {
            const logs = await containerLogs(name, { tail: 5000 });
            fs.writeFileSync(path.join(dir, `${name}-logs.txt`), logs);
          } catch {}
        }
        try {
          const { stdout } = await execInContainer(kContainerB, ["cat", kBootReportPath]);
          fs.writeFileSync(path.join(dir, `${kContainerB}-boot-report.json`), stdout);
        } catch {}
        try {
          const { stdout } = await execInContainer(kContainerB, ["cat", kThreadWitnessPath]);
          fs.writeFileSync(path.join(dir, `${kContainerB}-thread-witness.json`), stdout);
        } catch {}
      }
    } finally {
      // ALWAYS tear down — never leave containers or volumes behind.
      await removeContainer(kContainerA);
      await removeContainer(kContainerB);
      await removeVolume(kVolume);
    }
  }, 5 * kMin);

  step("builds the production image from the local checkout", 15 * kMin, async () => {
    await buildImage({ tag: kImageTag });
  });

  step("container A boots the pinned stable against a seeded volume: UI + pin + gateway healthz", 12 * kMin, async () => {
    await createVolume(kVolume);
    await seedVolume(kVolume, {
      "/data/onboarded.json": JSON.stringify({ onboardedAt: new Date().toISOString() }),
      [`${kOpenclawDir}/openclaw.json`]: JSON.stringify(buildSeedConfig(), null, 2),
    });
    await runContainer({ name: kContainerA, image: kImageTag, volume: kVolume, env: containerEnv() });
    await waitForUiUp(kContainerA, 3 * kMin);
    ctx.cookie = await loginForCookie(baseUrl(), kSetupPassword);
    await waitForVersion(kContainerA, ctx.stablePin, 5 * kMin);
    await waitFor(() => gatewayHealthzOk(kContainerA), {
      timeoutMs: 5 * kMin,
      intervalMs: 3000,
      label: `stable gateway /healthz inside ${kContainerA} (seeded config accepted?)`,
    });
  });

  step("reads a REAL thread id of A's server process from /proc/<pid>/task", 2 * kMin, async () => {
    // A's own format-2 claim names the server pid (writeServerPid at boot).
    const pidfile = await readJsonInContainer(kContainerA, kServerPidPath);
    expect(pidfile.format).toBe(kServerPidFormat);
    expect(Number.isInteger(pidfile.pid) && pidfile.pid > 0).toBe(true);
    ctx.serverPidA = pidfile.pid;
    const tids = await readThreadIds(kContainerA, ctx.serverPidA);
    // CEO 6.1: a real-TID fixture asserts the process is multi-threaded, else
    // the leg cannot mean anything (it would seed the leader's own pid).
    expect(tids.length, `/proc/${ctx.serverPidA}/task lists ${tids.length} entries`).toBeGreaterThan(1);
    expect(tids[0]).toBe(ctx.serverPidA);
    // A's identity is evidence about the old volume owner. It cannot predict
    // B's allocation: the old nonleader TID can become B's process leader.
    ctx.threadIdA = tids.find((tid) => tid !== ctx.serverPidA);
    expect(ctx.threadIdA).toBeGreaterThan(ctx.serverPidA);
    console.log(`[container-boot-e2e] A: server pid ${ctx.serverPidA}, threads ${tids.join(",")} → old claim tid ${ctx.threadIdA}`);
  });

  step("removes A and seeds the incident shape: legacy {pid: <tid>, at: <old>} + running run + interrupted restart op + .tmp archive", 3 * kMin, async () => {
    await removeContainer(kContainerA);
    const now = Date.now();
    await seedVolume(kVolume, {
      // RC1: the legacy claim naming a thread id, stamped two days ago.
      [kServerPidPath]: JSON.stringify({ pid: ctx.threadIdA, at: now - kLegacyClaimAgeMs }),
      // Inject B's own observed TID before its real pidfile guard. The armed
      // marker is consumed once; inherited child CLIs/restarts cannot reseed.
      [kThreadPreloadPath]: fs.readFileSync(path.join(__dirname, "fixtures", "seed-own-thread-claim.cjs"), "utf8"),
      [kThreadArmedPath]: JSON.stringify({ claimAt: now - kLegacyClaimAgeMs }),
      // A7: a ledger run its process never finished (openclaw-run-ledger.js
      // record shape — `running`, no finishedAt).
      [`${kRunsDir}/${kDanglingRunId}.json`]: JSON.stringify(
        {
          operationId: kDanglingRunId,
          target: { version: ctx.stablePin, channel: "stable", kind: "apply" },
          state: "running",
          startedAt: now - 10 * kMin,
          finishedAt: null,
          ok: null,
          result: null,
          steps: [{ name: "download", status: "running", at: now - 10 * kMin }],
          backup: null,
          dbPreflight: null,
          overseer: null,
          hasLog: false,
        },
        null,
        2,
      ),
      // A7: a gateway_restart operation left `running` by a foreign bootId
      // (restart-required-state.js reconcileOnBoot closes it as interrupted).
      [kRestartOperationPath]: JSON.stringify(
        {
          operationId: kInterruptedRestartId,
          kind: "gateway_restart",
          startedAt: now - 10 * kMin,
          bootId: "4242:1700000000000",
          expiresAt: now - 5 * kMin,
          status: "running",
          lastStep: "stopping",
          errorSummary: null,
          completedAt: null,
          code: null,
          reasonsSnapshot: [],
        },
        null,
        2,
      ),
      // #79: crash debris of a pre-apply backup (the incident's 8 GB file was
      // this shape; a few bytes prove the sweep just as well).
      [`${kBackupsDir}/${kTmpArchiveName}`]: "not-a-real-archive\n",
    });
  });

  step("container B boots on the seeded volume: UI + pin + gateway healthz", 12 * kMin, async () => {
    await runContainer({
      name: kContainerB, image: kImageTag, volume: kVolume,
      env: { ...containerEnv(), NODE_OPTIONS: `--require=${kThreadPreloadPath}` },
    });
    ctx.activeContainer = kContainerB;
    ctx.cookie = null;
    await waitForUiUp(kContainerB, 5 * kMin);
    await waitForVersion(kContainerB, ctx.stablePin, 10 * kMin);
    await waitFor(() => gatewayHealthzOk(kContainerB), {
      timeoutMs: 5 * kMin,
      intervalMs: 3000,
      label: `gateway /healthz inside ${kContainerB} after the seeded boot`,
    });
  });

  step("boot-report.json: the pidfile guard judged the legacy claim a THREAD and proceeded", 2 * kMin, async () => {
    // The server phase is merged from the listening path; poll until it is
    // recorded so a still-pending report cannot fail the read.
    ctx.bootReportB = await waitFor(
      async () => {
        const report = await readJsonInContainer(kContainerB, kBootReportPath);
        return report?.serverPhase?.status === "recorded" ? report : null;
      },
      { timeoutMs: 3 * kMin, intervalMs: 3000, label: "boot-report.json server phase recorded" },
    );
    const report = ctx.bootReportB;
    const witness = await readJsonInContainer(kContainerB, kThreadWitnessPath);
    ctx.threadWitnessB = witness;
    console.log(`[container-boot-e2e] B pidfile decision: ${JSON.stringify(report.pidfile)}`);
    expect(witness.threadId).not.toBe(witness.serverPid);
    expect(witness.threadIds).toContain(witness.threadId);
    expect(witness.tgid).toBe(witness.serverPid);
    expect(witness.status).toMatch(new RegExp(`^Tgid:\\s+${witness.serverPid}$`, "m"));
    expect(witness.status).toMatch(new RegExp(`^Pid:\\s+${witness.threadId}$`, "m"));
    expect(await fileExistsInContainer(kContainerB, kThreadArmedPath)).toBe(false);
    expect(report.pidfile).toBeTruthy();
    expect(report.pidfile.decision).toBe("proceed");
    // Codex 21: the MECHANISM fired — the Tgid rule recognised a thread, not
    // "dead" (the tid was not reallocated) or an argv verdict.
    expect(kThreadReasons).toContain(report.pidfile.reason);
    expect(report.pidfile.pid).toBe(witness.threadId);
    expect(report.pidfile.selfPid).toBe(witness.serverPid);
    expect(report.pidfile.claimAt).toBe(witness.claimAt);
    expect(report.pidfile.record?.format).toBe("legacy");
    expect(report.pidfile.record?.legacyClaim).toBe(true);
    expect(report.pidfile.tgid).toBe(witness.tgid);
    expect(report.pidfile.tgid).not.toBe(witness.threadId);
    if (report.pidfile.reason === "own_thread") expect(report.pidfile.tgid).toBe(report.pidfile.selfPid);
    // The bin phase ran the sync (not the pidfile skip) — the report's own
    // bin half says so.
    expect(report.binPhase?.status).toBe("ok");
    expect(report.serverPhase?.reason).not.toBe("pidfile_skip");
  });

  step("boot-report.json: the recorded build is the launched tree, the verdict is consistent, the dangling run was closed", 2 * kMin, async () => {
    const report = ctx.bootReportB;
    // installed === expected: the recorded build launched (a fresh container
    // on the same image needs no activation, so bootSync action is `none`;
    // an activation boot would say `activated` — both are the recorded build).
    const expected = report.openclaw?.expected ?? report.serverPhase?.channelInfo?.expectedVersion;
    const running = report.openclaw?.resolvedForLaunch ?? report.serverPhase?.installedVersion;
    expect(expected).toBe(ctx.stablePin);
    expect(running).toBe(ctx.stablePin);
    expect(["none", "activated"]).toContain(report.openclaw?.bootSync?.action);
    expect(report.openclaw?.installedDiverged).not.toBe(true);
    const verdict = Array.isArray(report.serverPhase?.verdict) ? report.serverPhase.verdict : null;
    expect(verdict).toEqual([]);
    // A7: the run left `running` is closed at boot and the report names it.
    expect(report.serverPhase?.danglingRecords?.closedRuns).toContain(kDanglingRunId);
    const run = await readJsonInContainer(kContainerB, `${kRunsDir}/${kDanglingRunId}.json`);
    expect(run.state).toBe("interrupted");
    expect(run.ok).toBe(false);
    expect(run.result?.code).toBe("interrupted");
  });

  step("volume after boot: B's own format-2 pidfile, the restart operation interrupted, the .tmp archive swept", 2 * kMin, async () => {
    const pidfile = await readJsonInContainer(kContainerB, kServerPidPath);
    expect(pidfile.format).toBe(kServerPidFormat);
    expect(pidfile.pid).toBe(ctx.threadWitnessB.serverPid);
    expect(pidfile.pid).not.toBe(ctx.threadWitnessB.threadId);
    expect(Number.isInteger(pidfile.startTicks) && pidfile.startTicks > 0).toBe(true);
    // The claim is B's OWN server: its pid is the thread leader of the tid we
    // seeded when the reason was own_thread.
    if (ctx.bootReportB.pidfile.reason === "own_thread") {
      expect(pidfile.pid).toBe(ctx.bootReportB.pidfile.selfPid);
    }
    const operation = await readJsonInContainer(kContainerB, kRestartOperationPath);
    expect(operation.operationId).toBe(kInterruptedRestartId);
    expect(operation.status).toBe("interrupted");
    expect(operation.errorSummary).toBe("AlphaClaw restarted before the operation finished");
    const tmpStillThere = await fileExistsInContainer(kContainerB, `${kBackupsDir}/${kTmpArchiveName}`);
    if (kSweepLanded) {
      expect(tmpStillThere, `${kTmpArchiveName} should have been swept at boot`).toBe(false);
    } else {
      console.warn(
        `[container-boot-e2e] .tmp archive ${tmpStillThere ? "still present" : "gone"} — the boot sweep (Stage 4) is not in this tree; not asserted`,
      );
    }
  });

  step("the gateway is healthy and /api/status agrees with the report", 3 * kMin, async () => {
    await waitFor(() => gatewayHealthzOk(kContainerB), {
      timeoutMs: 2 * kMin,
      intervalMs: 3000,
      label: `gateway /healthz inside ${kContainerB} at the end of the journey`,
    });
    const status = await readStatus();
    expect(versionMatches(status.openclawVersion, ctx.stablePin)).toBe(true);
  });
});
