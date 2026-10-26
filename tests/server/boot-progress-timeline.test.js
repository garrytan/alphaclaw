const { createBootTimeline, kUnverifiedAfterMs, kReadyBackstopGraceMs } = require("../../lib/server/boot-progress/timeline");
const { kBootSteps, kStageOrder, stageIndex } = require("../../lib/server/boot-progress/steps");
const { projectBootProgressPublic, projectBootProgressHuman, projectBootOverlay } = require("../../lib/server/boot-progress/projections");

const kHealthyReady = { lifecycle: "running", health: "healthy", readiness: "ready", replacementPending: null, crashCountInWindow: 0 };

const makeTimeline = (overrides = {}) => {
  let t = 10_000;
  const history = [];
  const timeline = createBootTimeline({
    bootId: "4242:1",
    startedAtMs: 8_000,
    now: () => t,
    readVersions: () => ({ alphaclaw: "0.10.8", openclaw: "2026.10.4" }),
    recordHistory: (entry) => history.push(entry),
    readyBudgetMs: 300_000,
    logger: { log: () => {}, warn: () => {} },
    ...overrides,
  });
  return { timeline, history, advance: (ms) => { t += ms; }, now: () => t };
};

// The startup.js order of a version-change boot.
const runBootSteps = (timeline, { doctor = true } = {}) => {
  for (const id of ["lock_contention", "restart_reconcile", "boot_report", "config_normalize"]) timeline.step(id);
  if (doctor) timeline.noteDoctorStart({ fromVersion: "2026.10.2", toVersion: "2026.10.4" });
  for (const id of ["native_maintenance", "autotune", "config_ensure", "prompt_sync", "channel_sync", "proxy_config", "report_finalize", "gateway_launch"]) timeline.step(id);
};

describe("boot timeline: stage mapping", () => {
  it("maps every startup step to exactly one stage, in boot order, so no stage reopens", () => {
    const order = ["bin_setup", "server_start", "lock_contention", "restart_reconcile", "boot_report", "config_normalize", "doctor", "native_maintenance", "autotune", "config_ensure", "prompt_sync", "channel_sync", "proxy_config", "report_finalize", "gateway_launch", "openclaw_startup", "lock_wait", "readiness"];
    expect(Object.keys(kBootSteps).sort()).toEqual([...order].sort());
    let last = -1;
    for (const id of order) {
      const index = stageIndex(kBootSteps[id].stage);
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
    }
    // Codex migration, plugin reconciliation and channel sync run after
    // Doctor: they are "Starting the gateway", never Preparing.
    expect(kBootSteps.native_maintenance.stage).toBe("gateway");
    expect(kBootSteps.channel_sync.stage).toBe("gateway");
  });

  it("starts in Preparing at the process start and walks the stages forward only", () => {
    const { timeline } = makeTimeline();
    expect(timeline.snapshot().stage).toBe("preparing");
    expect(timeline.snapshot().stages[0].startedAt).toBe(8_000);
    runBootSteps(timeline);
    const snap = timeline.snapshot();
    expect(snap.stage).toBe("gateway");
    expect(snap.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ["preparing", "done"],
      ["upgrading", "done"],
      ["gateway", "running"],
      ["channels", "pending"],
    ]);
    // A late evidence line for an earlier stage never reopens it.
    timeline.step("config_normalize");
    expect(timeline.snapshot().stage).toBe("gateway");
    expect(timeline.snapshot().stages[0].status).toBe("done");
  });

  it("hides the upgrade stage and keeps the initial kind when no Doctor runs", () => {
    const { timeline } = makeTimeline({ kind: "updating_alphaclaw" });
    runBootSteps(timeline, { doctor: false });
    const snap = timeline.snapshot();
    expect(snap.stages.map((stage) => stage.id)).toEqual(["preparing", "gateway", "channels"]);
    expect(snap.kind).toBe("updating_alphaclaw");
    expect(snap.headline).toBe("Updating AlphaClaw");
  });

  it("promotes the kind to Upgrading OpenClaw when the version-change Doctor starts (it wins over Updating AlphaClaw)", () => {
    const { timeline } = makeTimeline({ kind: "updating_alphaclaw" });
    timeline.noteDoctorStart({ fromVersion: "2026.10.2", toVersion: "2026.10.4" });
    const snap = timeline.snapshot();
    expect(snap.kind).toBe("upgrading_openclaw");
    expect(snap.stage).toBe("upgrading");
    expect(snap.doctor).toEqual({ ran: true, fromVersion: "2026.10.2", toVersion: "2026.10.4" });
  });

  it("reads OpenClaw's startup trace (both observed formats) as detail text and moves to Connecting channels at http.bound", () => {
    const { timeline } = makeTimeline();
    runBootSteps(timeline, { doctor: false });
    timeline.noteGatewayOutput("[gateway] startup phase: cli.bootstrap.admission.database-readiness starting total=2888.3ms\n");
    expect(timeline.snapshot().trace.words).toBe("Opening OpenClaw's databases");
    expect(timeline.snapshot().stage).toBe("gateway");
    timeline.noteGatewayOutput("2026-10-16T14:57:23.574+00:00 [gateway] startup phase: http.bound 0.0ms total=11552.8ms\n");
    expect(timeline.snapshot().stage).toBe("channels");
    // Unknown trace names degrade to the stage itself.
    timeline.noteGatewayOutput("[gateway] startup phase: something.new 1ms total=2ms\n");
    expect(timeline.snapshot().trace.words).toBe("Gateway is listening");
  });
});

describe("boot timeline: genuine activity only", () => {
  it("advances the activity sequence on steps and output, never on snapshots, observes or time", () => {
    const { timeline, advance } = makeTimeline();
    timeline.noteDoctorStart({});
    const before = timeline.snapshot().activitySeq;
    advance(60_000);
    timeline.snapshot();
    timeline.observe({ bootPhase: { phase: "starting_gateway" } });
    expect(timeline.snapshot().activitySeq).toBe(before);
    timeline.noteActivity();
    expect(timeline.snapshot().activitySeq).toBe(before + 1);
  });

  it("marks a quiet boot stalled after 2 minutes and stuck after 15, in the projection only", () => {
    const { timeline, now, advance } = makeTimeline();
    timeline.noteDoctorStart({});
    advance(119_000);
    expect(projectBootProgressPublic(timeline.snapshot(), { now: now() }).stalled).toBe(false);
    advance(2_000);
    expect(projectBootProgressPublic(timeline.snapshot(), { now: now() })).toMatchObject({ stalled: true, stuck: false });
    advance(14 * 60_000);
    expect(projectBootProgressPublic(timeline.snapshot(), { now: now() }).stuck).toBe(true);
    timeline.noteActivity();
    expect(projectBootProgressPublic(timeline.snapshot(), { now: now() })).toMatchObject({ stalled: false, stuck: false });
  });
});

describe("boot timeline: Doctor progress (ALPH-23)", () => {
  it("shows Doctor's phase to humans only, and counts a changed progress as activity", () => {
    const { timeline, now, advance } = makeTimeline();
    timeline.noteDoctorProgress({ phase: "capture", words: "Making a recovery copy: 1.0 of 16.0 GB" });
    expect(timeline.snapshot().doctorProgress).toBeNull();
    timeline.noteDoctorStart({});
    const before = timeline.snapshot().activitySeq;
    advance(100_000);
    timeline.noteDoctorProgress({ phase: "capture", words: "Making a recovery copy: 1.0 of 16.0 GB" });
    expect(timeline.snapshot().activitySeq).toBe(before + 1);
    advance(30_000);
    timeline.noteDoctorProgress({ phase: "capture", words: "Making a recovery copy: 1.0 of 16.0 GB" });
    expect(timeline.snapshot().activitySeq).toBe(before + 1);
    advance(100_000);
    expect(projectBootProgressPublic(timeline.snapshot(), { now: now() }).stalled).toBe(true);
    timeline.noteDoctorProgress({ phase: "capture", words: "Making a recovery copy: 5.5 of 16.0 GB" });
    const human = projectBootProgressHuman(timeline.snapshot(), { now: now() });
    expect(human).toMatchObject({ stalled: false, doctorProgress: { phase: "capture", words: "Making a recovery copy: 5.5 of 16.0 GB" } });
    expect(projectBootProgressPublic(timeline.snapshot(), { now: now() })).not.toHaveProperty("doctorProgress");
  });
});

describe("boot timeline: terminal table", () => {
  const launched = () => {
    const ctx = makeTimeline();
    runBootSteps(ctx.timeline, { doctor: false });
    return ctx;
  };

  it("bootPhase ready is NOT success; verified native readiness is", () => {
    const { timeline, history } = launched();
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: { lifecycle: "running", health: "unknown", readiness: "unknown", replacementPending: { pid: 1 } } });
    expect(timeline.isTerminal()).toBe(false);
    // Port up, sidecars settling, identity still pending: Connecting channels.
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: { lifecycle: "running", health: "healthy", readiness: "not_ready", readinessStatus: "starting", replacementPending: { pid: 1 } } });
    expect(timeline.snapshot().stage).toBe("channels");
    expect(timeline.isTerminal()).toBe(false);
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: kHealthyReady });
    expect(timeline.snapshot().outcome).toBe("ready");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ outcome: "ready", complete: true, kind: "restarting", openclawVersion: "2026.10.4" });
  });

  it("waits through the watchdog's owner-heartbeat lock wait instead of failing, then follows the relaunch to ready", () => {
    const { timeline, history, advance, now } = makeTimeline();
    runBootSteps(timeline, { doctor: false });
    advance(2_000);
    const lapseAt = now() + 81_000;
    const waiting = {
      lifecycle: "running",
      health: "degraded",
      degradedReason: "owner_lease_held",
      crashCountInWindow: 0,
      incumbentConflict: { kind: "owner_lease_held", holderPid: null, holderRole: null, heartbeatLapseAtMs: lapseAt },
      incumbentGraceUntil: new Date(lapseAt).toISOString(),
    };
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: waiting });
    expect(timeline.isTerminal()).toBe(false);
    expect(timeline.snapshot()).toMatchObject({
      stage: "gateway",
      step: expect.objectContaining({ id: "lock_wait", label: "Waiting for OpenClaw's state ownership" }),
      lockWait: { kind: "owner_lease_held", untilMs: lapseAt },
    });
    expect(projectBootProgressHuman(timeline.snapshot(), { now: now() }).lockWait).toEqual({ kind: "owner_lease_held", untilMs: lapseAt });
    // The public frame never carries step detail.
    expect(projectBootProgressPublic(timeline.snapshot(), { now: now() })).not.toHaveProperty("lockWait");
    advance(80_000);
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: { ...waiting, incumbentGraceUntil: null } });
    expect(timeline.isTerminal()).toBe(false);
    // The watchdog relaunched: the conflict clears with the new launch.
    advance(2_000);
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: { lifecycle: "running", health: "unknown", crashCountInWindow: 0, incumbentConflict: null } });
    expect(timeline.snapshot()).toMatchObject({ step: expect.objectContaining({ id: "gateway_launch" }), lockWait: null });
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: kHealthyReady });
    expect(timeline.snapshot().outcome).toBe("ready");
    expect(history[0]).toMatchObject({ outcome: "ready" });
  });

  it("a lock wait that ends in the watchdog's relaunch cap still fails the boot", () => {
    const { timeline } = makeTimeline();
    runBootSteps(timeline, { doctor: false });
    const conflict = { kind: "owner_lease_held", holderPid: null, holderRole: null };
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: { lifecycle: "running", health: "degraded", crashCountInWindow: 0, incumbentConflict: conflict } });
    expect(timeline.isTerminal()).toBe(false);
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: { lifecycle: "crash_loop", health: "unhealthy", crashCountInWindow: 0, incumbentConflict: conflict } });
    expect(timeline.snapshot()).toMatchObject({ outcome: "failed", reason: "gateway_exited", lockWait: null });
  });

  it.each([
    ["config_error", { lifecycle: "configuration_error" }],
    ["gateway_exited", { lifecycle: "running", crashCountInWindow: 1 }],
    ["gateway_exited", { lifecycle: "crash_loop" }],
    ["readiness_failed", { lifecycle: "running", health: "degraded", readiness: "not_ready", readinessReason: "state-db" }],
  ])("fails at the current stage on %s", (reason, watchdog) => {
    const { timeline, history } = launched();
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog });
    const snap = timeline.snapshot();
    expect(snap).toMatchObject({ outcome: "failed", reason, failedStage: "gateway" });
    expect(snap.stages.find((stage) => stage.id === "gateway").status).toBe("failed");
    expect(history[0]).toMatchObject({ outcome: "failed", complete: false, reason });
  });

  it("fails boot_failed before the launch too", () => {
    const { timeline } = makeTimeline();
    timeline.noteDoctorStart({});
    timeline.observe({ bootPhase: { phase: "failed", error: "x" } });
    expect(timeline.snapshot()).toMatchObject({ outcome: "failed", reason: "boot_failed", failedStage: "upgrading" });
  });

  it("is superseded by a user Restart / Retry upgrade / repair starting before readiness", () => {
    const { timeline } = launched();
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: { lifecycle: "running", health: "unknown" }, activeOperation: { kind: "restart" } });
    expect(timeline.snapshot()).toMatchObject({ outcome: "superseded", reason: "restart" });
  });

  it("is superseded when the boot finished without launching (lost lease)", () => {
    const { timeline } = makeTimeline();
    timeline.step("config_normalize");
    timeline.observe({ bootPhase: { phase: "ready" } });
    expect(timeline.snapshot()).toMatchObject({ outcome: "superseded", reason: "gateway_held" });
  });

  it("treats fail-open readiness as unverified, never as success", () => {
    const { timeline, advance } = launched();
    const failOpen = { lifecycle: "running", health: "healthy", readiness: "unknown", readinessProbe: "unsupported", replacementPending: null };
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: failOpen });
    expect(timeline.isTerminal()).toBe(false);
    advance(kUnverifiedAfterMs);
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: failOpen });
    expect(timeline.snapshot()).toMatchObject({ outcome: "unverified", reason: "readiness_unknown" });
  });

  it("ends ready_timeout when nothing decides within the ready budget", () => {
    const { timeline, advance } = launched();
    const pending = { lifecycle: "running", health: "unknown", readiness: "unknown", replacementPending: { pid: 9 } };
    advance(300_000 + kReadyBackstopGraceMs - 1);
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: pending });
    expect(timeline.isTerminal()).toBe(false);
    advance(2);
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: pending });
    expect(timeline.snapshot()).toMatchObject({ outcome: "failed", reason: "ready_timeout" });
  });

  it("never reopens after a terminal outcome, and records history exactly once", () => {
    const { timeline, history } = launched();
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: { lifecycle: "configuration_error" } });
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: kHealthyReady });
    timeline.step("readiness");
    timeline.abort();
    expect(timeline.snapshot().outcome).toBe("failed");
    expect(history).toHaveLength(1);
  });

  it("aborts on shutdown and records an aborted row", () => {
    const { timeline, history } = makeTimeline();
    timeline.abort("shutdown");
    expect(history[0]).toMatchObject({ outcome: "aborted", complete: false });
  });

  it("ends at listen for a box that is not onboarded: no card, no history", () => {
    const { timeline, history } = makeTimeline();
    timeline.markNotOnboarded();
    expect(timeline.snapshot().outcome).toBe("not_onboarded");
    expect(projectBootOverlay(timeline.snapshot())).toBeNull();
    expect(history).toHaveLength(0);
  });
});

describe("boot timeline: projections", () => {
  it("keeps versions, paths, step names, trace text and reasons out of the public frame", () => {
    const { timeline, now } = makeTimeline();
    runBootSteps(timeline);
    timeline.noteGatewayOutput("[gateway] startup phase: config.auth starting total=1ms /data/.openclaw/openclaw.json <script>alert(1)</script>\n");
    timeline.observe({ bootPhase: { phase: "ready" }, watchdog: { lifecycle: "configuration_error" } });
    const frame = projectBootProgressPublic(timeline.snapshot(), { now: now() });
    const text = JSON.stringify(frame);
    expect(Object.keys(frame).sort()).toEqual(["activitySeq", "bootId", "endedAt", "estimateMs", "kind", "label", "outcome", "stage", "stages", "stalled", "startedAt", "stuck", "v"]);
    expect(text).not.toMatch(/2026\.10|0\.10\.8|4242/);
    expect(text).not.toMatch(/\/data|openclaw\.json|script|config_error|doctor|Loading configuration/i);
    expect(frame.bootId).toMatch(/^[0-9a-f]{12}$/);
    const human = projectBootProgressHuman(timeline.snapshot(), { now: now() });
    expect(human.versions).toEqual({ alphaclaw: "0.10.8", openclaw: "2026.10.4" });
    expect(human.doctor.toVersion).toBe("2026.10.4");
    expect(human.reason).toBe("config_error");
    expect(human.trace.words).toBe("Loading configuration");
  });
});
