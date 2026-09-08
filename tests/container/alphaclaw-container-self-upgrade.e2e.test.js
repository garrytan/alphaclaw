const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  describeContainer, repoRoot, docker, assertDockerAvailable, buildImage,
  sourceAtCommit, removeImage, createVolume, seedVolume, runContainer,
  getMappedPort, execInContainer, containerLogs, removeContainer, removeVolume,
  ensureArtifactsDir, waitFor, loginForCookie, fetchJsonWithCookie,
} = require("./container-helpers");

const kBaselineCommit = "01d3b66bf1caf00488b38d468590359de04b98fd";
// This release has state 15 / agent 19, like the incoming 2026.9.2 pin,
// while being a DISTINCT immutable package. Activation cannot be a no-op.
const kRecordedVersion = "2026.8.2";
const kId = crypto.randomUUID().slice(0, 8);
const kImages = [`alphaclaw-self-upgrade-old:${kId}`, `alphaclaw-self-upgrade-new:${kId}`];
const kContainers = [`alphaclaw-self-upgrade-old-${kId}`, `alphaclaw-self-upgrade-new-${kId}`];
const kVolume = `alphaclaw-self-upgrade-${kId}`;
const kManaged = "/data/.openclaw/.alphaclaw";
const kConfig = "/data/.openclaw/openclaw.json";
const kPassword = "self-upgrade-fixture-password";
const kGatewayToken = "self-upgrade-fixture-gateway-token";
const kMin = 60_000;
const readJson = async (container, file) => JSON.parse((await execInContainer(container, ["cat", file])).stdout);

const waitReady = async (container, version) => {
  let cookie;
  let port;
  await waitFor(async () => {
    port = await getMappedPort(container);
    const base = `http://127.0.0.1:${port}`;
    if (!cookie) cookie = await loginForCookie(base, kPassword);
    const status = await fetchJsonWithCookie(`${base}/api/status`, cookie);
    if (!(status.openclawVersion === version || status.openclawVersion?.startsWith(`${version} `))) return false;
    await execInContainer(container, ["curl", "-fsS", "--max-time", "15", "http://127.0.0.1:18789/healthz"]);
    await execInContainer(container, ["curl", "-fsS", "--max-time", "15", "http://127.0.0.1:18789/readyz"]);
    return true;
  }, { timeoutMs: 10 * kMin, intervalMs: 3000, label: `${container} actually serving OpenClaw ${version}` });
};

describeContainer("container E2E: immutable v0.9.76 → candidate self-upgrade preserves the recorded overlay", () => {
  let broken = false;
  const baselineArtifacts = new Map();
  afterAll(async () => {
    try {
      if (broken) {
        const dir = ensureArtifactsDir();
        for (const [file, contents] of baselineArtifacts) fs.writeFileSync(path.join(dir, file), contents);
        for (const container of kContainers) {
          try { fs.writeFileSync(path.join(dir, `${container}.log`), await containerLogs(container, { tail: 5000 })); } catch {}
          for (const file of ["boot-report.json", "boot-report-incident.json", "openclaw-channel-state.json"]) {
            try {
              const { stdout } = await execInContainer(container, ["cat", `${kManaged}/${file}`]);
              fs.writeFileSync(path.join(dir, `${container}-${file}`), stdout);
            } catch {}
          }
        }
      }
    } finally {
      for (const container of kContainers) await removeContainer(container);
      await removeVolume(kVolume);
      for (const image of kImages) await removeImage(image);
    }
  }, 5 * kMin);

  test("boots both images on one volume and proves real activation, preserved intent, and pidfile convergence", { timeout: 60 * kMin, retry: 0 }, async () => {
    try {
      await assertDockerAvailable();
      const candidate = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
      expect(candidate.dependencies.openclaw).not.toBe(kRecordedVersion);
      const sourceRoot = await sourceAtCommit(kBaselineCommit);
      expect(JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).version).toBe("0.9.76");
      await buildImage({ tag: kImages[0], sourceRoot });
      await buildImage({ tag: kImages[1] });
      await createVolume(kVolume);
      await seedVolume(kVolume, {
        "/data/onboarded.json": JSON.stringify({ onboardedAt: new Date().toISOString() }),
        [kConfig]: JSON.stringify({ gateway: { mode: "local", bind: "loopback", port: 18789, auth: { token: kGatewayToken } } }),
      });

      // Seed through the old release's installer/store while no gateway owns
      // the volume. Both databases are authored by the recorded real CLI.
      const seed = `
        const fs = require('node:fs'), path = require('node:path');
        const { execFileSync } = require('node:child_process');
        const { DatabaseSync } = require('node:sqlite');
        const root = path.dirname(require.resolve('alphaclaw/package.json'));
        const { installOpenclawVersionToTempDir } = require(path.join(root, 'lib/server/openclaw-version'));
        const { createOpenclawReleaseChannelStore } = require(path.join(root, 'lib/server/openclaw-release-channel'));
        (async () => {
          const staged = await installOpenclawVersionToTempDir({ versionSpec: ${JSON.stringify(kRecordedVersion)}, timeoutMs: 8 * 60_000 });
          try {
            const store = createOpenclawReleaseChannelStore({ rootDir: '/data', openclawDir: '/data/.openclaw' });
            const saved = store.saveOverlayFromTempInstall({ version: ${JSON.stringify(kRecordedVersion)}, openclawPackageDir: staged.openclawPackageDir });
            if (!saved.ok) throw new Error(saved.error);
            const bin = store.resolvePackageBin(staged.openclawPackageDir);
            const env = { ...process.env, HOME: '/data', OPENCLAW_HOME: '/data', OPENCLAW_STATE_DIR: '/data/.openclaw', OPENCLAW_CONFIG_PATH: ${JSON.stringify(kConfig)}, OPENCLAW_NO_AUTO_UPDATE: '1' };
            const config = fs.readFileSync(${JSON.stringify(kConfig)});
            const approvals = execFileSync(process.execPath, [bin, 'approvals', 'get', '--json'], { env, encoding: 'utf8', timeout: 120_000 });
            JSON.parse(approvals);
            fs.mkdirSync('/data/.openclaw/agents/main/sessions', { recursive: true });
            fs.writeFileSync('/data/.openclaw/agents/main/sessions/sessions.json', JSON.stringify({ 'agent:main:main': { sessionId: '11111111-1111-4111-8111-111111111111', updatedAt: 1780000000000 } }));
            execFileSync(process.execPath, [bin, 'doctor', '--fix', '--non-interactive'], { env, stdio: 'pipe', timeout: 120_000 });
            fs.writeFileSync(${JSON.stringify(kConfig)}, config);
            for (const [file, expected, role] of [['state/openclaw.sqlite', 15, 'state'], ['agents/main/agent/openclaw-agent.sqlite', 19, 'agent']]) {
              const db = new DatabaseSync(path.join('/data/.openclaw', file));
              if (db.prepare('PRAGMA user_version').get().user_version !== expected) throw new Error('Unexpected immutable ' + role + ' schema');
              if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Corrupt immutable ' + role + ' fixture');
              if (role === 'agent') {
                const owner = db.prepare("SELECT role, agent_id, schema_version FROM schema_meta WHERE meta_key = 'primary'").get();
                if (owner?.role !== 'agent' || owner.agent_id !== 'main' || owner.schema_version !== 19) throw new Error('Invalid agent schema owner');
              }
              db.close();
            }
            store.updateState((state) => ({ ...state, pinVersion: ${JSON.stringify(candidate.dependencies.openclaw)}, applied: { channel: 'stable', version: ${JSON.stringify(kRecordedVersion)}, at: Date.now(), acceptedAt: Date.now(), reason: 'self_upgrade_fixture' } }));
          } finally { staged.cleanup(); }
        })().catch((error) => { console.error(error); process.exitCode = 1; });
      `;
      await docker(["run", "--rm", "--entrypoint", "node", "-v", `${kVolume}:/data`, kImages[0], "-e", seed], { timeoutMs: 12 * kMin });

      const env = { SETUP_PASSWORD: kPassword, OPENCLAW_GATEWAY_TOKEN: kGatewayToken };
      await runContainer({ name: kContainers[0], image: kImages[0], volume: kVolume, env });
      await waitReady(kContainers[0], kRecordedVersion);
      expect((await readJson(kContainers[0], `${kManaged}/openclaw-channel-state.json`)).applied.version).toBe(kRecordedVersion);

      // Fresh operator intent differs from any pre-fix backup. Preserve its
      // bytes over the AlphaClaw upgrade, not merely one version field.
      // Seed the documented channel/auto-update mirror too: boot is required
      // to reconcile it, and that expected write is not a config restoration.
      const edit = `
        const fs = require('node:fs');
        const p = ${JSON.stringify(kConfig)};
        const c = JSON.parse(fs.readFileSync(p));
        c.messages = { ...c.messages, ackReaction: '🧪' };
        c.update = { ...c.update, channel: 'stable', auto: { ...c.update?.auto, enabled: false } };
        fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\\n');
      `;
      await execInContainer(kContainers[0], ["node", "-e", edit]);
      const configBefore = (await execInContainer(kContainers[0], ["cat", kConfig])).stdout;
      baselineArtifacts.set(`${kContainers[0]}-openclaw-config.json`, configBefore);
      const baselineClaim = await readJson(kContainers[0], `${kManaged}/alphaclaw-server.pid`);
      expect(baselineClaim.pid).toBeGreaterThan(0);
      baselineArtifacts.set(`${kContainers[0]}.log`, await containerLogs(kContainers[0], { tail: 5000 }));
      // v0.9.76 predates boot reports. Its serving version, logs and channel
      // ledger establish the baseline; the candidate must produce a report.
      for (const file of ["openclaw-channel-state.json"]) {
        baselineArtifacts.set(`${kContainers[0]}-${file}`, (await execInContainer(kContainers[0], ["cat", `${kManaged}/${file}`])).stdout);
      }
      await removeContainer(kContainers[0]);

      // Keep a legacy format claim to exercise convergence across the real
      // image replacement. The deterministic TID collision remains a
      // separate same-image test, where PID allocation is controlled.
      await seedVolume(kVolume, { [`${kManaged}/alphaclaw-server.pid`]: JSON.stringify({ pid: baselineClaim.pid, at: Date.now() - 2 * 86400_000 }) });
      await runContainer({ name: kContainers[1], image: kImages[1], volume: kVolume, env });
      await waitReady(kContainers[1], kRecordedVersion);
      const report = await waitFor(async () => {
        const value = await readJson(kContainers[1], `${kManaged}/boot-report.json`);
        return value.serverPhase?.status === "recorded" ? value : null;
      }, { timeoutMs: 2 * kMin, intervalMs: 2000, label: "candidate boot report" });
      expect(report.pidfile.decision).toBe("proceed");
      expect(report.openclaw.bootSync.action).toBe("activated");
      expect(report.openclaw.expected).toBe(kRecordedVersion);
      expect(report.openclaw.resolvedForLaunch).toBe(kRecordedVersion);
      expect(report.openclaw.installedDiverged).not.toBe(true);
      expect(report.serverPhase.verdict).toEqual([]);
      expect(report.serverPhase.config.restoredFrom).toBeNull();
      expect((await execInContainer(kContainers[1], ["cat", kConfig])).stdout).toBe(configBefore);
      const state = await readJson(kContainers[1], `${kManaged}/openclaw-channel-state.json`);
      expect(state.applied.version).toBe(kRecordedVersion);
      expect(state.gatewayHold).toBeNull();
      const claim = await readJson(kContainers[1], `${kManaged}/alphaclaw-server.pid`);
      expect(claim.format).toBe(2);
      expect(claim.startTicks).toBeGreaterThan(0);
      const identity = `const fs=require('node:fs');const pid=${Number(claim.pid)};const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');const tail=stat.slice(stat.lastIndexOf(')')+2).split(' ');console.log(JSON.stringify({startTicks:Number(tail[19]),status:fs.readFileSync('/proc/'+pid+'/status','utf8')}));`;
      const observed = JSON.parse((await execInContainer(kContainers[1], ["node", "-e", identity])).stdout);
      expect(observed.startTicks).toBe(claim.startTicks);
      expect(observed.status).toMatch(new RegExp(`Tgid:\\s+${claim.pid}\\b`));
    } catch (error) {
      broken = true;
      throw error;
    }
  });
});
