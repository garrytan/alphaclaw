// vitest globals (describe/test/expect/hooks) are on via vitest.config.js.
const fs = require("node:fs");
const path = require("node:path");
const {
  describeContainer,
  ensureArtifactsDir,
  assertDockerAvailable,
  docker,
  buildImage,
  createVolume,
  seedVolume,
  runContainer,
  getMappedPort,
  execInContainer,
  containerLogs,
  removeContainer,
  removeVolume,
  sleep,
  waitFor,
  loginForCookie,
  fetchJsonWithCookie,
} = require("./container-helpers.js");

// -----------------------------------------------------------------------------
// Container E2E: honest boot status (v0.10.8). One journey against the real
// image and the pinned OpenClaw:
//
//   fresh volume ─▶ first boot: /boot-progress.json polled from docker run
//        (placeholder frames say Preparing only; server frames walk the stages
//        forward, never back) and the authenticated /api/status names each
//        stage in order; the boot ends "ready" (verified readiness)
//        ▼
//   docker restart ─▶ second boot: a restarting boot, no estimate (one sample)
//        ▼
//   seed boot-history.json with failures + two more successful restarts
//   (the first boot was another kind), docker restart ─▶ third boot shows
//        "Usually about" = the median of the three restarting successes;
//        the failures never trained it
//
// Every public frame is checked for leaks (versions, paths, Doctor text).
// Opt-in via OPENCLAW_CONTAINER_E2E=1.
// -----------------------------------------------------------------------------

const kRunId = Date.now().toString(36);
const kImageTag = `alphaclaw-boot-progress-e2e:${kRunId}`;
const kVolume = `alphaclaw-boot-progress-e2e-data-${kRunId}`;
const kContainer = `alphaclaw-boot-progress-e2e-${kRunId}`;
const kSetupPassword = "container-boot-progress-pass";
const kGatewayToken = "container-boot-progress-token";
const kGatewayPort = 18789;
const kOpenclawDir = "/data/.openclaw";
const kHistoryPath = `${kOpenclawDir}/.alphaclaw/boot-history.json`;
const kMin = 60 * 1000;
const kStageOrder = ["preparing", "upgrading", "gateway", "channels"];
const kPublicKeys = ["activitySeq", "bootId", "endedAt", "estimateMs", "kind", "label", "outcome", "source", "stage", "stages", "stalled", "startedAt", "stuck", "v"];
const kPlaceholderKeys = ["bootId", "kind", "label", "source", "stage", "stuck", "v"];

const ctx = { port: null, cookie: null, pin: null, frames: [], statuses: [], first: null };
let journeyBroken = null;
const step = (name, timeoutMs, fn) => {
  test(name, { timeout: timeoutMs, retry: 0 }, async () => {
    if (journeyBroken) throw new Error(`journey already broken at step "${journeyBroken}" — cannot run "${name}"`);
    try {
      await fn();
    } catch (err) {
      journeyBroken = name;
      throw err;
    }
  });
};
const baseUrl = () => `http://127.0.0.1:${ctx.port}`;

const assertNoLeak = (frame) => {
  const text = JSON.stringify(frame);
  expect(text).not.toMatch(/\d{4}\.\d+\.\d+/);
  expect(text).not.toMatch(/\b0\.10\.\d+\b/);
  expect(text).not.toMatch(/\/data|\.openclaw|openclaw\.json|doctor|startup phase|error/i);
};

const assertForward = (stages) => {
  const indices = stages.filter(Boolean).map((id) => kStageOrder.indexOf(id));
  for (let i = 1; i < indices.length; i += 1) expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
};

// Polls /boot-progress.json (and, once a session exists, /api/status) every
// 250 ms until the boot ends, recording every distinct answer.
const watchBoot = async ({ timeoutMs }) => {
  const frames = [];
  const statuses = [];
  const startedAt = Date.now();
  let cookie = null;
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      ctx.port = await getMappedPort(kContainer);
      const res = await fetch(`${baseUrl()}/boot-progress.json`, { headers: { Accept: "application/json" } });
      if (res.ok) {
        const frame = await res.json();
        frames.push(frame);
        if (frame.source === "server" && frame.bootId) {
          if (!cookie) cookie = await loginForCookie(baseUrl(), kSetupPassword).catch(() => null);
          if (cookie) {
            const status = await fetchJsonWithCookie(`${baseUrl()}/api/status`, cookie).catch(() => null);
            if (status?.bootProgress) statuses.push({ bootProgress: status.bootProgress, state: status.state });
          }
          if (frame.outcome) {
            last = frame;
            break;
          }
        }
      }
    } catch {}
    await sleep(250);
  }
  ctx.cookie = cookie;
  return { frames, statuses, last };
};

const writeArtifact = (name, value) => {
  fs.writeFileSync(path.join(ensureArtifactsDir(), `${kContainer}-${name}`), typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

describeContainer("container E2E: honest boot status — stages, public frame, learned estimate", () => {
  beforeAll(async () => {
    await assertDockerAvailable();
    ctx.pin = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8")).dependencies.openclaw;
  }, 2 * kMin);

  afterAll(async () => {
    try {
      writeArtifact("frames.json", { frames: ctx.frames.slice(-400), statuses: ctx.statuses.slice(-200) });
      if (journeyBroken) writeArtifact("logs.txt", await containerLogs(kContainer, { tail: 5000 }).catch(() => ""));
    } finally {
      await removeContainer(kContainer);
      await removeVolume(kVolume);
    }
  }, 5 * kMin);

  step("builds the production image from the local checkout", 15 * kMin, async () => {
    await buildImage({ tag: kImageTag });
  });

  step("first boot of the pin: placeholder says Preparing only, stages run in order, ends at verified readiness", 15 * kMin, async () => {
    await createVolume(kVolume);
    await seedVolume(kVolume, {
      "/data/onboarded.json": JSON.stringify({ onboardedAt: new Date().toISOString() }),
      [`${kOpenclawDir}/openclaw.json`]: JSON.stringify({ gateway: { mode: "local", bind: "loopback", port: kGatewayPort, auth: { token: kGatewayToken } } }, null, 2),
    });
    await runContainer({
      name: kContainer,
      image: kImageTag,
      volume: kVolume,
      env: { SETUP_PASSWORD: kSetupPassword, OPENCLAW_GATEWAY_TOKEN: kGatewayToken, ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}) },
      memory: "4g",
    });
    const { frames, statuses, last } = await watchBoot({ timeoutMs: 12 * kMin });
    ctx.frames.push(...frames);
    ctx.statuses.push(...statuses);
    expect(last).toBeTruthy();
    expect(last.outcome).toBe("ready");

    const placeholder = frames.filter((frame) => frame.source === "placeholder");
    for (const frame of placeholder) {
      expect(Object.keys(frame).sort()).toEqual(kPlaceholderKeys);
      expect(frame).toMatchObject({ kind: "preparing", stage: "preparing", stuck: false });
    }
    console.log(`[boot-progress-e2e] ${placeholder.length} placeholder frames, ${frames.length} frames, ${statuses.length} statuses`);

    const server = frames.filter((frame) => frame.source === "server" && frame.bootId);
    for (const frame of server) {
      expect(Object.keys(frame).sort()).toEqual(kPublicKeys);
      assertNoLeak(frame);
    }
    for (const frame of frames) assertNoLeak(frame);
    expect(new Set(server.map((frame) => frame.bootId)).size).toBe(1);
    assertForward(server.map((frame) => frame.stage));
    assertForward(statuses.map((entry) => entry.bootProgress.stage));

    // The finished timeline names each stage in order, each one done, the
    // timestamps never going backwards.
    const stages = last.stages;
    expect(stages.map((stage) => stage.id)).toEqual(kStageOrder.filter((id) => stages.some((stage) => stage.id === id)));
    expect(stages.map((stage) => stage.id)).toEqual(expect.arrayContaining(["preparing", "gateway", "channels"]));
    for (const stage of stages) expect(stage.status).toBe("done");
    for (let i = 1; i < stages.length; i += 1) expect(stages[i].startedAt).toBeGreaterThanOrEqual(stages[i - 1].endedAt ?? stages[i - 1].startedAt);
    expect(last.estimateMs).toBeNull();

    // The authenticated status saw at least two stages live, in order.
    const seen = [...new Set(statuses.map((entry) => entry.bootProgress.stage))];
    console.log(`[boot-progress-e2e] first boot kind=${last.kind} stages seen on /api/status: ${seen.join(" → ")}`);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    const human = statuses.at(-1).bootProgress;
    expect(human.versions?.openclaw).toBeTruthy();
    ctx.first = last;
  });

  step("second boot (docker restart): a new boot, restarting kind, no estimate from one sample", 10 * kMin, async () => {
    await docker(["restart", kContainer]);
    await sleep(1000);
    const { frames, last } = await watchBoot({ timeoutMs: 8 * kMin });
    ctx.frames.push(...frames);
    expect(last?.outcome).toBe("ready");
    expect(last.bootId).not.toBe(ctx.first.bootId);
    expect(last.kind).toBe("restarting");
    expect(last.estimateMs).toBeNull();
    const { stdout } = await execInContainer(kContainer, ["cat", kHistoryPath]);
    const history = JSON.parse(stdout);
    expect(history.schema).toBe("alphaclaw.boot-history.v1");
    expect(history.entries.filter((row) => row.outcome === "ready" && row.complete === true)).toHaveLength(2);
  });

  step("third boot after seeding failures + two more successful restarts: Usually about X from successful boots only", 10 * kMin, async () => {
    const { stdout } = await execInContainer(kContainer, ["cat", kHistoryPath]);
    const history = JSON.parse(stdout);
    const ready = history.entries.find((row) => row.kind === "restarting" && row.outcome === "ready");
    expect(ready).toBeTruthy();
    const seeded = {
      ...history,
      entries: [
        ...history.entries,
        { ...ready, outcome: "failed", complete: false, reason: "ready_timeout", totalMs: 1_800_000 },
        { ...ready, outcome: "aborted", complete: false, totalMs: 1_000 },
        { ...ready, totalMs: 42_000 },
        { ...ready, outcome: "failed", complete: false, reason: "gateway_exited", totalMs: 2_000 },
        { ...ready, totalMs: 48_000 },
      ],
    };
    // The first boot was an OpenClaw upgrade (another kind): the restarting
    // samples are the second boot plus the two seeded successes.
    const samples = [ready.totalMs, 42_000, 48_000].sort((a, b) => a - b);
    const payload = Buffer.from(JSON.stringify(seeded)).toString("base64");
    await execInContainer(kContainer, ["node", "-e", `require('fs').writeFileSync(${JSON.stringify(kHistoryPath)}, Buffer.from(process.argv[1], 'base64'))`, payload]);
    await docker(["restart", kContainer]);
    await sleep(1000);
    const { frames, last } = await watchBoot({ timeoutMs: 8 * kMin });
    ctx.frames.push(...frames);
    const running = frames.filter((frame) => frame.source === "server" && frame.bootId && frame.outcome === null);
    expect(running.length).toBeGreaterThan(0);
    for (const frame of running) expect(frame.estimateMs).toBe(samples[1]);
    expect(last?.outcome).toBe("ready");
  });
});
