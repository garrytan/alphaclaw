// vitest globals (describe/test/expect/hooks) are on via vitest.config.js.
const {
  describeContainer,
  assertDockerAvailable,
  docker,
  buildImage,
  createVolume,
  removeVolume,
  removeImage,
} = require("./container-helpers.js");

// -----------------------------------------------------------------------------
// Container E2E: the read-only snapshot preflight (lib/server/
// openclaw-capture-preflight.js) is a PORT of the pinned OpenClaw's own
// staging check, so it must agree with the real Doctor — this leg is the
// differential that fails when a pin bump changes the rule.
//
// On the #144 layout (state dir symlinked under /data, /data root:node 2775):
//   preflight says unavailable at /data (ancestor_replaceable), fixable by the
//   sticky bit  ⇔  the real `openclaw doctor --fix` prints "Pre-repair
//   recovery copy was unavailable: … /data" (2026.11.5's wording; up to
//   2026.11.4 "Original state capture was unavailable: … /data")
//   then Enable snapshots (applySnapshotEnable, the route's primitive) sets
//   +t on exactly /data, the preflight flips to available  ⇔  the real Doctor
//   retains a pre-repair capture manifest (2026.11.5 writes it without
//   printing its path).
//
// Opt-in via OPENCLAW_CONTAINER_E2E=1 (npm run test:container).
// -----------------------------------------------------------------------------

const kSuffix = Date.now().toString(36);
const tag = `alphaclaw-preflight-e2e:${kSuffix}`;
const volume = `alphaclaw-preflight-e2e-${kSuffix}`;
const kLib = "/app/node_modules/alphaclaw/lib/server";
const kEnv = "OPENCLAW_STATE_DIR=/data/.openclaw OPENCLAW_CONFIG_PATH=/data/stronghold-wm/wintermute/openclaw.json";

const run = async (script) => {
  const { stdout, stderr } = await docker(
    ["run", "--rm", "--entrypoint", "sh", "-v", `${volume}:/data`, "-e", "HOME=/root", tag, "-c", script],
    { timeoutMs: 10 * 60 * 1000 },
  );
  return `${stdout}${stderr}`;
};
const node = (code) => run(`node -e '${code.replaceAll("'", "'\\''")}'`);
const preflight = async () => {
  const out = await node(
    `const p = require("${kLib}/openclaw-capture-preflight.js"); process.stdout.write("PREFLIGHT " + JSON.stringify(p.evaluateCapturePreflight({ stateDir: "/data/.openclaw" })));`,
  );
  return JSON.parse(out.slice(out.indexOf("PREFLIGHT ") + "PREFLIGHT ".length).trim().split("\n")[0]);
};
// AlphaClaw's Doctor runner clears the setgid bit the state dir inherits from
// /data first (OpenClaw 2026.11.5's Doctor refuses to create directories under
// it), so the real Doctor runs the way AlphaClaw runs it.
const doctor = () =>
  run(`chmod g-s /data/.openclaw/ && cd /tmp && ${kEnv} openclaw doctor --fix --non-interactive 2>&1; echo DOCTOR_EXIT=$?`);

describeContainer("container: snapshot preflight vs the pinned Doctor (#144 layout)", () => {
  beforeAll(async () => {
    await assertDockerAvailable();
    await buildImage({ tag });
    await createVolume(volume);
    await run(
      "chown root:node /data && chmod 2775 /data && mkdir -p /data/stronghold-wm/wintermute && " +
        "ln -sfn /data/stronghold-wm/wintermute /data/.openclaw && echo '{}' > /data/stronghold-wm/wintermute/openclaw.json",
    );
  }, 30 * 60 * 1000);

  afterAll(async () => {
    await removeVolume(volume).catch(() => {});
    await removeImage(tag).catch(() => {});
  }, 5 * 60 * 1000);

  test("unavailable on the 2775 layout, matching Doctor's own refusal", async () => {
    const verdict = await preflight();
    expect(verdict).toMatchObject({
      captureAvailable: false,
      failingPath: "/data",
      failingRule: "ancestor_replaceable",
      symlinked: true,
      captureRoot: "/data/stronghold-wm/wintermute.update-captures",
      fixable: { canFix: true, reason: "sticky_bit" },
    });
    const out = await doctor();
    expect(out).toContain("Pre-repair recovery copy was unavailable: SQLite staging ancestor must not allow another user to replace its child: /data");
    expect(out).toContain("DOCTOR_EXIT=0");
  }, 15 * 60 * 1000);

  test("Enable snapshots sets +t on exactly /data; the preflight and the real Doctor then both keep a capture", async () => {
    const out = await node(`
      const { evaluateCapturePreflight } = require("${kLib}/openclaw-capture-preflight.js");
      const { buildSnapshotEnableProposal, applySnapshotEnable } = require("${kLib}/openclaw-snapshot-enable.js");
      const proposal = buildSnapshotEnableProposal(evaluateCapturePreflight({ stateDir: "/data/.openclaw" }));
      const result = applySnapshotEnable({ proposalId: proposal.proposalId, stateDir: "/data/.openclaw", logger: { log() {}, warn() {} } });
      process.stdout.write("ENABLE " + JSON.stringify({ dirs: proposal.dirs, ok: result.ok, changed: result.changed, captureAvailable: result.captureAvailable }));
    `);
    const enable = JSON.parse(out.slice(out.indexOf("ENABLE ") + "ENABLE ".length).trim().split("\n")[0]);
    expect(enable).toMatchObject({
      ok: true,
      captureAvailable: true,
      changed: [{ path: "/data", oldMode: "02775", newMode: "03775" }],
    });
    expect((await run("stat -c %a /data")).trim()).toBe("3775");
    expect(await preflight()).toMatchObject({ captureAvailable: true, failingPath: null });
    const before = await run("ls -d /data/stronghold-wm/wintermute.update-captures/doctor-*/manifest.json 2>/dev/null | wc -l");
    const doctorOut = await doctor();
    expect(doctorOut).toContain("DOCTOR_EXIT=0");
    expect(doctorOut).not.toContain("recovery copy was unavailable");
    const after = await run("ls -d /data/stronghold-wm/wintermute.update-captures/doctor-*/manifest.json 2>/dev/null | wc -l");
    expect(Number(after.trim())).toBe(Number(before.trim()) + 1);
  }, 15 * 60 * 1000);
});
