// Local Claude Code rescue session — spawns `claude remote-control` on THIS
// box inside a detached tmux session and extracts its claude.ai/code/<id>
// Remote Control URL, so the sidebar launcher can jump the operator into a
// session with hands on the actual machine.
//
//   click/incident/boot ─▶ [file-locked mutex] ─▶ adopt? ─▶ tmux new-session
//         │                                          │            │ remain-on-exit
//         │                                   state.json URL      ▼
//         │                                   (identity-bound)  URL watcher (500ms, gen-guarded)
//         ▼                                                       │ trust auto-answer
//   GET status  ◀── snapshot (probes memoized, NEVER spawns) ◀────┤ auth-gate detectors
//                                                                 ▼
//                                             running {sessionUrl} → button navigates
//
// Auth reality (binary-verified + fixture-pinned): Remote Control REFUSES
// API keys — it needs full-scope OAuth from `claude auth login` under THIS
// service's dedicated HOME, and ANTHROPIC_API_KEY must be absent from the
// child env. buildRescueEnv() is therefore an allowlist (the overseer's
// discipline, watchdog-overseer.js), and the guided login flow below drives
// `claude auth login` in a script(1) PTY, surfacing the OAuth URL to the UI
// and forwarding the pasted code.
//
// Concurrency: ONE lifecycle mutex (in-process op slot + cross-process file
// lock — overlapping AlphaClaw generations exist during self-restart) around
// every mutation, held through spawn but never through the URL wait; a
// generation counter makes stale async completions (URL watcher, login
// watcher) no-ops after stop/restart.
const fs = require("fs");
const path = require("path");
const { spawnInPty, hasScriptCommand } = require("../pty-process");
const { createTmuxDriver } = require("./tmux");
const {
  stripAnsi,
  extractRemoteControlUrl,
  extractOauthUrl,
  detectAuthGateError,
  detectTrustPrompt,
  detectAwaitingCode,
  detectLoginSuccess,
  detectLoginFailure,
  detectBridgeDisconnect,
} = require("./tui");
const { readStateFile, writeStateFile, clearStateFile } = require("./state-file");
const { buildSecretReplacements } = require("../helpers");
const constants = require("../constants");

const kProbeTtlMs = 60_000;
const kProbeTimeoutMs = 10_000;
const kUrlPollMs = 500;
// Server concludes before the client's 90s poll cap — a cold claude boot
// (feature-flag fetch on a slow network) can pass 45s, so 60s.
const kUrlDeadlineMs = 60_000;
const kTrustWatchMs = 250;
const kLoginPollMs = 250;
const kLoginTtlMs = 10 * 60 * 1000;
const kLoginBufferMaxChars = 200_000;
const kTailMaxChars = 8_000;
// Unattended spawns (autostart/incident) skip below this floor: the rescue
// session (~200MB idle TUI) must never be what OOMs the box it exists to
// save. Manual clicks stay allowed (operator judgment) with a warning.
const kMemoryFloorBytes = 500 * 1024 * 1024;
const kFileLockStaleMs = 2 * 60 * 1000;
const kLoginCodeMaxChars = 512;

const kPermissionModes = new Set(["default", "acceptEdits", "bypassPermissions"]);
const kDisabledValues = new Set(["0", "false", "no", "off"]);

const createClaudeCodeLocalService = ({
  env = process.env,
  fsModule = fs,
  spawnImpl = undefined, // threads into spawnInPty (login PTY / script hosting)
  execFileImpl = undefined, // threads into the tmux driver
  runStream = null, // createRunStream() instance for claude probes
  tmux = null, // injectable driver for tests
  getResources = null, // () => getSystemResources() shape
  nowFn = Date.now,
  logger = console,
  sessionName = constants.kClaudeCodeLocalSessionName,
  paths = {},
  timers = {},
} = {}) => {
  const dirs = {
    root: paths.root || constants.kClaudeCodeLocalDir,
    home: paths.home || constants.kClaudeCodeLocalHomeDir,
    workspace: paths.workspace || constants.kClaudeCodeLocalWorkspaceDir,
    stateFile: paths.stateFile || constants.kClaudeCodeLocalStateFile,
    socket: paths.socket || constants.kClaudeCodeLocalSocketPath,
    lockFile: paths.lockFile || constants.kClaudeCodeLocalLockFile,
  };
  const intervals = {
    probeMs: timers.probeMs ?? kProbeTtlMs,
    urlPollMs: timers.urlPollMs ?? kUrlPollMs,
    urlDeadlineMs: timers.urlDeadlineMs ?? kUrlDeadlineMs,
    trustWatchMs: timers.trustWatchMs ?? kTrustWatchMs,
    loginPollMs: timers.loginPollMs ?? kLoginPollMs,
    loginTtlMs: timers.loginTtlMs ?? kLoginTtlMs,
  };
  const driver =
    tmux ||
    createTmuxDriver({ socketPath: dirs.socket, execFileImpl: execFileImpl });

  // ---------------------------------------------------------------- state --
  let generation = 0;
  let currentOp = null; // { name } — one mutation at a time, busy otherwise
  let session = null; // { phase, hosting, mode, cwd, spawnedBy, startedAt, generation, sessionId, sessionUrl, panePid, proc?, buffer? }
  let login = null; // { phase, proc, buffer, oauthUrl, startedAt, generation }
  let lastLogin = null; // { phase: "success"|"failed", error? } for the modal
  let lastError = null; // { code, message, tailSanitized, at }
  let lastExitTail = null; // sanitized death screen for the tail endpoint
  let stopping = false;
  let probeState = null; // { at, installed, claudeVersion, loggedIn, tmuxOk, tmuxVersion, versionWarning }
  let probeInFlight = null;
  let probeTimer = null;
  let loginCodeSecrets = []; // pasted codes — redacted from every tail/log
  let disposed = false;

  const log = (message) => {
    try {
      logger.log?.(`[claude-code-local] ${message}`);
    } catch {}
  };
  const warnLog = (message) => {
    try {
      (logger.warn || logger.log || (() => {})).call(
        logger,
        `[claude-code-local] ${message}`,
      );
    } catch {}
  };

  // --------------------------------------------------------------- config --
  const isEnabled = () =>
    !kDisabledValues.has(String(env.CLAUDE_CODE_LOCAL_ENABLED ?? "").trim().toLowerCase());
  const isAutostart = () =>
    ["1", "true", "yes", "on"].includes(
      String(env.CLAUDE_CODE_LOCAL_AUTOSTART ?? "").trim().toLowerCase(),
    );
  const isSpawnOnIncident = () =>
    !kDisabledValues.has(
      String(env.CLAUDE_CODE_LOCAL_SPAWN_ON_INCIDENT ?? "").trim().toLowerCase(),
    );
  const configuredPermissionMode = () => {
    const raw = String(env.CLAUDE_CODE_LOCAL_PERMISSION_MODE ?? "").trim();
    if (!raw) return "acceptEdits";
    if (kPermissionModes.has(raw)) return raw;
    warnLog(`invalid CLAUDE_CODE_LOCAL_PERMISSION_MODE "${raw}" — using acceptEdits`);
    return "acceptEdits";
  };
  const configuredCwd = () => {
    const raw = String(env.CLAUDE_CODE_LOCAL_CWD ?? "").trim();
    if (!raw) return dirs.workspace;
    if (!path.isAbsolute(raw)) {
      warnLog(`CLAUDE_CODE_LOCAL_CWD is not absolute ("${raw}") — using the managed workspace`);
      return dirs.workspace;
    }
    return raw;
  };

  // Allowlist-built child env: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
  // CLAUDE_CODE_OAUTH_TOKEN / DISABLE_GROWTHBOOK / CLAUDE_CODE_ROUTINE_* /
  // BROWSER are excluded BY CONSTRUCTION (Remote Control refuses key auth,
  // growthbook must evaluate, and no browser must try to open on a headless
  // box — the login flow needs the URL printed, not opened).
  const kRescueEnvKeys = ["PATH", "LANG", "LC_ALL", "TMPDIR", "NO_COLOR"];
  const buildRescueEnv = () => {
    const isolated = {};
    for (const key of kRescueEnvKeys) {
      if (env[key] !== undefined) isolated[key] = env[key];
    }
    isolated.TERM = "xterm-256color";
    isolated.HOME = dirs.home;
    isolated.CLAUDE_REMOTE_CONTROL_SESSION_NAME_PREFIX = "alphaclaw";
    return isolated;
  };

  // 0700 throughout: home/ holds the full-scope OAuth credential. This is
  // ambient-pickup hygiene, not a uid boundary (same-uid processes can read
  // anything); the dedicated HOME exists so no OTHER child (gateway, agents,
  // overseers) resolves ~/.claude here implicitly. Any future whole-rootDir
  // backup MUST exclude home/ (re-login after restore is the recovery).
  const ensureDirs = () => {
    for (const dir of [dirs.root, dirs.home, dirs.workspace]) {
      fsModule.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const claudeJson = path.join(dirs.home, ".claude.json");
    if (!fsModule.existsSync(claudeJson)) {
      // Pre-seed first-run answers; the spawn watcher's trust auto-answer is
      // the backstop when a CLI version adds a new prompt.
      fsModule.writeFileSync(
        claudeJson,
        `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  };

  // -------------------------------------------------------- redaction ------
  const sanitizeText = (text, { maxChars = kTailMaxChars } = {}) => {
    let detail = stripAnsi(String(text || ""));
    for (const code of loginCodeSecrets) {
      if (code) detail = detail.split(code).join("${LOGIN_CODE}");
    }
    for (const [value, replacement] of buildSecretReplacements(env)) {
      detail = detail.split(value).join(replacement);
    }
    return detail.slice(-maxChars);
  };
  const sanitizeLine = (text) =>
    sanitizeText(text, { maxChars: 4000 }).replace(/[\r\n]+/g, " ").slice(0, 300);

  // ------------------------------------------------------------ file lock --
  // Cross-process guard for the shared tmux resource: AlphaClaw self-restart
  // (alphaclaw-version.js) briefly overlaps two server generations. PID +
  // staleness, best-effort — the in-process op slot is the primary gate.
  const acquireFileLock = () => {
    const payload = JSON.stringify({ pid: process.pid, at: nowFn() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fsModule.writeFileSync(dirs.lockFile, payload, { flag: "wx", mode: 0o600 });
        return true;
      } catch (error) {
        if (error?.code !== "EEXIST") return true; // fail open: mkdir raced etc.
        let holder = null;
        try {
          holder = JSON.parse(fsModule.readFileSync(dirs.lockFile, "utf8"));
        } catch {}
        const holderPid = Number(holder?.pid);
        const holderAt = Number(holder?.at);
        let holderAlive = false;
        if (Number.isFinite(holderPid) && holderPid > 0) {
          try {
            process.kill(holderPid, 0);
            holderAlive = holderPid !== process.pid;
          } catch {
            holderAlive = false;
          }
        }
        const stale =
          !holderAlive ||
          !Number.isFinite(holderAt) ||
          nowFn() - holderAt > kFileLockStaleMs;
        if (!stale) return false;
        try {
          fsModule.rmSync(dirs.lockFile, { force: true });
        } catch {}
      }
    }
    return false;
  };
  const releaseFileLock = () => {
    try {
      const holder = JSON.parse(fsModule.readFileSync(dirs.lockFile, "utf8"));
      if (Number(holder?.pid) !== process.pid) return;
    } catch {}
    try {
      fsModule.rmSync(dirs.lockFile, { force: true });
    } catch {}
  };

  const runExclusive = async (name, fn) => {
    if (currentOp) {
      return { ok: false, code: "busy", message: `A ${currentOp.name} operation is already in progress.` };
    }
    currentOp = { name };
    if (!acquireFileLock()) {
      currentOp = null;
      return {
        ok: false,
        code: "busy",
        message: "Another AlphaClaw process holds the rescue-session lock — retry shortly.",
      };
    }
    generation += 1;
    try {
      return await fn({ generation });
    } finally {
      releaseFileLock();
      currentOp = null;
    }
  };

  // --------------------------------------------------------------- probes --
  const probeClaude = async () => {
    if (!runStream) return { installed: null, claudeVersion: null, loggedIn: null };
    const rescueEnv = buildRescueEnv();
    const version = await runStream.runStreamed({
      command: "claude",
      args: ["--version"],
      env: rescueEnv,
      cwd: dirs.home,
      timeoutMs: kProbeTimeoutMs,
    });
    if (version.error || version.code !== 0) {
      return { installed: false, claudeVersion: null, loggedIn: null };
    }
    const claudeVersion = (stripAnsi(version.tail).match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
    const auth = await runStream.runStreamed({
      command: "claude",
      args: ["auth", "status"],
      env: rescueEnv,
      cwd: dirs.home,
      timeoutMs: kProbeTimeoutMs,
    });
    // The rescue env carries no API key, so loggedIn:true here can only mean
    // OAuth credentials exist under the rescue HOME — exactly what Remote
    // Control requires. A parse failure reads as logged-out (fail closed:
    // worst case is an unnecessary login prompt, never a wrong spawn).
    let loggedIn = false;
    try {
      const { parseJsonFromNoisyOutput } = require("../helpers");
      const parsed = parseJsonFromNoisyOutput(auth.tail);
      loggedIn = parsed?.loggedIn === true;
    } catch {
      loggedIn = false;
    }
    return { installed: true, claudeVersion, loggedIn };
  };

  const refreshProbes = ({ force = false } = {}) => {
    if (probeInFlight) return probeInFlight;
    if (!force && probeState && nowFn() - probeState.at < intervals.probeMs) {
      return Promise.resolve(probeState);
    }
    probeInFlight = (async () => {
      try {
        ensureDirs();
      } catch (error) {
        warnLog(`ensureDirs failed: ${error?.message}`);
      }
      const rescueEnv = buildRescueEnv();
      const [claude, tmuxProbe] = await Promise.all([
        probeClaude().catch(() => ({ installed: null, claudeVersion: null, loggedIn: null })),
        driver.hasTmux({ env: rescueEnv }).catch(() => ({ ok: false, version: "" })),
      ]);
      const versionWarning =
        claude.claudeVersion &&
        !constants.kClaudeCodeLocalTestedVersionPattern.test(claude.claudeVersion)
          ? `claude ${claude.claudeVersion} is outside the tested range — TUI parsing may need new fixtures`
          : null;
      probeState = {
        at: nowFn(),
        installed: claude.installed,
        claudeVersion: claude.claudeVersion,
        loggedIn: claude.loggedIn,
        tmuxOk: tmuxProbe.ok,
        tmuxVersion: tmuxProbe.version || null,
        versionWarning,
      };
      await checkSessionLiveness().catch(() => {});
      return probeState;
    })().finally(() => {
      probeInFlight = null;
    });
    return probeInFlight;
  };

  // ------------------------------------------------------ session helpers --
  const persistSession = () => {
    if (!session) {
      clearStateFile({ filePath: dirs.stateFile, fsModule });
      return;
    }
    writeStateFile({
      filePath: dirs.stateFile,
      fsModule,
      logger,
      state: {
        sessionName,
        phase: session.phase,
        hosting: session.hosting,
        mode: session.mode,
        cwd: session.cwd,
        spawnedBy: session.spawnedBy,
        startedAt: session.startedAt,
        sessionId: session.sessionId || null,
        sessionUrl: session.sessionUrl || null,
        panePid: session.panePid || null,
        lastError: lastError || null,
      },
    });
  };

  const panePidAlive = (pid) => {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      return fsModule.existsSync(`/proc/${pid}`);
    } catch {
      return false;
    }
  };

  // has-session alone lies twice: remain-on-exit keeps dead panes "present",
  // and an SSH-attached human can add windows that outlive the claude pane.
  // Liveness = session exists AND the recorded pane PID is alive.
  const isTmuxSessionAlive = async () => {
    const rescueEnv = buildRescueEnv();
    const { alive } = await driver.hasSession({ sessionName, env: rescueEnv });
    if (!alive) return { alive: false };
    const info = await driver.listPaneInfo({ sessionName, env: rescueEnv });
    if (!info) return { alive: false };
    if (info.paneDead) return { alive: false, paneDead: true };
    if (session?.panePid && info.panePid && info.panePid !== session.panePid) {
      return { alive: true, panePid: info.panePid, identityMismatch: true };
    }
    return { alive: panePidAlive(info.panePid), panePid: info.panePid };
  };

  const reapDeadTmuxSession = async () => {
    const rescueEnv = buildRescueEnv();
    // Capture the death screen BEFORE reaping — remain-on-exit preserved it
    // exactly for this moment.
    const tail = await driver.capturePane({ sessionName, lines: 200, env: rescueEnv });
    if (tail) lastExitTail = sanitizeText(tail);
    await driver.killSession({ sessionName, env: rescueEnv });
  };

  const checkSessionLiveness = async () => {
    if (!session || session.hosting !== "tmux") return;
    const liveness = await isTmuxSessionAlive();
    if (liveness.alive) {
      if (session.phase === "running" && session.lastCaptureWarned !== true) {
        const tail = await driver.capturePane({
          sessionName,
          lines: 100,
          env: buildRescueEnv(),
        });
        if (tail && detectBridgeDisconnect(tail)) {
          session.warnings = ["Remote Control bridge may be disconnected — check the session"];
        } else {
          session.warnings = [];
        }
      }
      return;
    }
    log(`session process died (${session.phase}) — reaping pane, back to ready`);
    await reapDeadTmuxSession().catch(() => {});
    session = null;
    persistSession();
  };

  // Pane command: env -i K=V… claude remote-control … as ARGV items — no
  // shell string exists anywhere in this path. Unattended spawns clamp to
  // acceptEdits regardless of configuration: bypassPermissions only ever
  // reaches a session through an interactive click whose consent copy named
  // the mode (server-enforced here, not client logic).
  const buildSpawnCommand = ({ source, useContinue = false }) => {
    const unattended = source !== "click";
    const mode = unattended
      ? "acceptEdits"
      : configuredPermissionMode();
    const rescueEnv = buildRescueEnv();
    const argv = ["env", "-i"];
    for (const [key, value] of Object.entries(rescueEnv)) {
      argv.push(`${key}=${value}`);
    }
    argv.push("claude", "remote-control", "--name", sessionName);
    if (mode === "acceptEdits") argv.push("--permission-mode", "acceptEdits");
    if (mode === "bypassPermissions") argv.push("--dangerously-skip-permissions");
    if (useContinue) argv.push("-c");
    return { argv, mode };
  };

  const memoryFloorOk = () => {
    if (typeof getResources !== "function") return { ok: true };
    try {
      const sample = getResources();
      const total = sample?.memory?.totalBytes;
      const used = sample?.memory?.usedBytes;
      if (!Number.isFinite(total) || !Number.isFinite(used)) return { ok: true };
      const available = total - used;
      if (available < kMemoryFloorBytes) {
        return {
          ok: false,
          availableMb: Math.round(available / (1024 * 1024)),
        };
      }
      return { ok: true };
    } catch {
      return { ok: true };
    }
  };

  const setError = (code, message, tail) => {
    lastError = {
      code,
      message,
      tailSanitized: tail ? sanitizeText(tail) : null,
      at: nowFn(),
    };
    warnLog(`${code}: ${sanitizeLine(message)}`);
  };

  // Watches a freshly spawned tmux session until the Remote Control URL
  // appears. Generation-guarded end to end: a stop/restart during the wait
  // makes every late completion a no-op.
  const watchForUrl = async (gen) => {
    const rescueEnv = buildRescueEnv();
    const deadline = nowFn() + intervals.urlDeadlineMs;
    const trustDeadline = nowFn() + 15_000;
    let lastTrustAnswerAt = 0;
    while (nowFn() < deadline) {
      if (gen !== generation || !session || session.generation !== gen) return;
      const buffer = await driver.capturePane({ sessionName, lines: 800, env: rescueEnv });
      if (gen !== generation || !session || session.generation !== gen) return;
      if (buffer != null) {
        const found = extractRemoteControlUrl(buffer);
        if (found) {
          session.phase = "running";
          session.sessionId = found.sessionId;
          session.sessionUrl = found.sessionUrl;
          lastError = null;
          persistSession();
          log(`running — session ${found.sessionId} (${session.spawnedBy}, mode ${session.mode})`);
          return;
        }
        const gate = detectAuthGateError(buffer);
        if (gate) {
          setError(
            gate === "needs_login" ? "needs_login" : gate,
            gate === "env_conflict"
              ? "The claude CLI saw an Anthropic API key in its environment — this should be impossible with the rescue env; check for wrapper scripts."
              : "Remote Control refused to start — the rescue login is missing or the account has no claude.ai subscription.",
            buffer,
          );
          await reapDeadTmuxSession().catch(() => {});
          if (gen === generation && session?.generation === gen) {
            session = null;
            persistSession();
            // The auth gate is authoritative: the login probe memo is stale.
            probeState = null;
          }
          return;
        }
        if (
          nowFn() < trustDeadline &&
          nowFn() - lastTrustAnswerAt > 2_000 &&
          detectTrustPrompt(buffer)
        ) {
          lastTrustAnswerAt = nowFn();
          await driver.sendKeys({ sessionName, text: "1", env: rescueEnv });
        }
      }
      const liveness = await isTmuxSessionAlive();
      if (gen !== generation || !session || session.generation !== gen) return;
      if (!liveness.alive) {
        await reapDeadTmuxSession().catch(() => {});
        setError(
          "spawn_failed",
          "The claude process exited before publishing a Remote Control URL.",
          lastExitTail,
        );
        session = null;
        persistSession();
        return;
      }
      await new Promise((r) => setTimeout(r, intervals.urlPollMs));
    }
    if (gen !== generation || !session || session.generation !== gen) return;
    const buffer = await driver.capturePane({ sessionName, lines: 800, env: rescueEnv });
    setError(
      "url_extract_timeout",
      `No Remote Control URL after ${Math.round(intervals.urlDeadlineMs / 1000)}s — the session is kept for diagnosis (view the output tail, then Stop to retry).`,
      buffer,
    );
    // Deliberately keep the session: the tail endpoint + card viewer read it.
    session.phase = "running_no_url";
    persistSession();
  };

  // Escalating scrollback search so adoption never loads a 50k-line history
  // when the URL sits in the last screen.
  const extractUrlFromScrollback = async () => {
    const rescueEnv = buildRescueEnv();
    for (const lines of [2_000, 10_000, null]) {
      const buffer = await driver.capturePane({ sessionName, lines, env: rescueEnv });
      if (!buffer) return null;
      const found = extractRemoteControlUrl(buffer);
      if (found) return found;
      if (lines === null) return null;
    }
    return null;
  };

  // Adopt a live session (boot, or a click racing an existing spawn). Trusts
  // the persisted URL only when the live pane matches the recorded identity
  // (pane PID) — otherwise re-extracts from scrollback so a scrolled-out URL
  // cannot strand a live session, and a REPLACED session cannot serve a stale
  // URL.
  const adoptSession = async ({ gen }) => {
    const persisted = readStateFile({ filePath: dirs.stateFile, fsModule, logger });
    const rescueEnv = buildRescueEnv();
    const { alive } = await driver.hasSession({ sessionName, env: rescueEnv });
    if (!alive) {
      if (persisted) clearStateFile({ filePath: dirs.stateFile, fsModule });
      return false;
    }
    const info = await driver.listPaneInfo({ sessionName, env: rescueEnv });
    if (!info || info.paneDead || !panePidAlive(info.panePid)) {
      log("found a dead rescue pane — capturing tail and reaping");
      await reapDeadTmuxSession().catch(() => {});
      if (persisted) clearStateFile({ filePath: dirs.stateFile, fsModule });
      return false;
    }
    const identityMatches =
      persisted?.panePid && info.panePid && persisted.panePid === info.panePid;
    let sessionId = identityMatches ? persisted.sessionId : null;
    let sessionUrl = identityMatches ? persisted.sessionUrl : null;
    if (!sessionUrl) {
      const found = await extractUrlFromScrollback();
      if (found) {
        sessionId = found.sessionId;
        sessionUrl = found.sessionUrl;
      }
    }
    session = {
      phase: sessionUrl ? "running" : "running_no_url",
      hosting: "tmux",
      mode: identityMatches ? persisted.mode || null : null,
      cwd: identityMatches ? persisted.cwd || null : null,
      spawnedBy: identityMatches ? persisted.spawnedBy || "adopted" : "adopted",
      startedAt: identityMatches ? persisted.startedAt || nowFn() : nowFn(),
      generation: gen,
      sessionId,
      sessionUrl,
      panePid: info.panePid,
      warnings: [],
    };
    if (!sessionUrl) {
      const buffer = await driver.capturePane({ sessionName, lines: 800, env: rescueEnv });
      setError(
        "adopted_without_url",
        "A live rescue session was adopted but its URL is not recoverable — stop and restart it.",
        buffer,
      );
    } else {
      lastError = null;
      log(`adopted live session ${sessionId} (pane ${info.panePid})`);
    }
    persistSession();
    return true;
  };

  const spawnTmuxSession = async ({ gen, source, useContinue }) => {
    const rescueEnv = buildRescueEnv();
    const { argv, mode } = buildSpawnCommand({ source, useContinue });
    const cwd = configuredCwd();
    try {
      fsModule.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    } catch {}
    let created = await driver.newSession({
      sessionName,
      cwd,
      commandArgv: argv,
      env: rescueEnv,
    });
    if (
      created.code !== 0 &&
      /error connecting|no such file or directory/i.test(created.stderr || "")
    ) {
      // Stale socket inode after a crash/OOM: unlink and retry exactly once.
      try {
        fsModule.rmSync(dirs.socket, { force: true });
      } catch {}
      created = await driver.newSession({
        sessionName,
        cwd,
        commandArgv: argv,
        env: rescueEnv,
      });
    }
    if (created.code !== 0) {
      setError(
        "spawn_failed",
        `tmux could not start the rescue session: ${sanitizeLine(created.stderr || created.error?.message || "unknown error")}`,
        created.stderr,
      );
      return false;
    }
    const info = await driver.listPaneInfo({ sessionName, env: rescueEnv });
    session = {
      phase: "starting",
      hosting: "tmux",
      mode,
      cwd,
      spawnedBy: source,
      startedAt: nowFn(),
      generation: gen,
      sessionId: null,
      sessionUrl: null,
      panePid: info?.panePid || null,
      warnings: [],
    };
    lastError = null;
    persistSession();
    log(`spawned (${source}, mode ${mode}, cwd ${cwd}, pane ${info?.panePid ?? "?"})`);
    watchForUrl(gen).catch((error) => warnLog(`url watcher failed: ${error?.message}`));
    return true;
  };

  // script(1) hosting: the degraded mode for boxes without tmux. The child is
  // OURS (dies with AlphaClaw — the card says so); output accumulates in an
  // in-process ring buffer standing in for capture-pane.
  const spawnScriptSession = async ({ gen, source }) => {
    const { argv, mode } = buildSpawnCommand({ source, useContinue: false });
    const cwd = configuredCwd();
    try {
      fsModule.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    } catch {}
    let proc;
    try {
      proc = spawnInPty(argv, { cwd, env: buildRescueEnv(), spawnImpl });
    } catch (error) {
      setError("spawn_failed", `script(1) spawn failed: ${error?.message}`, null);
      return false;
    }
    session = {
      phase: "starting",
      hosting: "script",
      mode,
      cwd,
      spawnedBy: source,
      startedAt: nowFn(),
      generation: gen,
      sessionId: null,
      sessionUrl: null,
      panePid: proc.pid || null,
      proc,
      buffer: "",
      warnings: ["degraded: script hosting does not survive AlphaClaw restarts"],
    };
    lastError = null;
    const append = (chunk) => {
      if (!session || session.generation !== gen) return;
      session.buffer = (session.buffer + String(chunk)).slice(-kLoginBufferMaxChars);
    };
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    proc.on("error", (error) => {
      if (gen !== generation || session?.generation !== gen) return;
      setError("spawn_failed", `script(1) child failed: ${error?.message}`, session?.buffer);
      session = null;
      persistSession();
    });
    proc.on("exit", () => {
      if (session?.generation !== gen) return;
      lastExitTail = sanitizeText(session.buffer || "");
      if (session.phase === "starting") {
        setError("spawn_failed", "The claude process exited before publishing a Remote Control URL.", session.buffer);
      } else {
        log("script-hosted session exited — back to ready");
      }
      session = null;
      persistSession();
    });
    persistSession();
    const deadline = nowFn() + intervals.urlDeadlineMs;
    const poll = async () => {
      while (nowFn() < deadline) {
        if (gen !== generation || !session || session.generation !== gen) return;
        const found = extractRemoteControlUrl(session.buffer);
        if (found) {
          session.phase = "running";
          session.sessionId = found.sessionId;
          session.sessionUrl = found.sessionUrl;
          persistSession();
          log(`running — session ${found.sessionId} (script hosting)`);
          return;
        }
        const gate = detectAuthGateError(session.buffer);
        if (gate) {
          setError(gate === "needs_login" ? "needs_login" : gate, "Remote Control refused to start.", session.buffer);
          try {
            session.proc?.kill("SIGTERM");
          } catch {}
          session = null;
          persistSession();
          probeState = null;
          return;
        }
        if (detectTrustPrompt(session.buffer)) {
          try {
            session.proc?.stdin?.write("1\n");
          } catch {}
        }
        await new Promise((r) => setTimeout(r, intervals.urlPollMs));
      }
      if (gen !== generation || !session || session.generation !== gen) return;
      setError("url_extract_timeout", "No Remote Control URL — session kept for diagnosis.", session.buffer);
      session.phase = "running_no_url";
      persistSession();
    };
    poll().catch((error) => warnLog(`script url watcher failed: ${error?.message}`));
    log(`spawned (${source}, mode ${mode}, script hosting)`);
    return true;
  };

  // ----------------------------------------------------------- public ops --
  const startSession = async ({ confirmed = false, source = "click" } = {}) => {
    if (!isEnabled()) return { ok: false, code: "disabled", message: "Local rescue sessions are disabled (CLAUDE_CODE_LOCAL_ENABLED)." };
    const probes = await refreshProbes();
    if (probes?.installed === false) {
      return { ok: false, code: "not_installed", message: "The claude CLI is not installed on this box — npm install -g @anthropic-ai/claude-code." };
    }
    if (login) return { ok: false, code: "login_in_progress", message: "Finish (or cancel) the Claude login first." };
    if (probes?.loggedIn === false) {
      return { ok: false, code: "needs_login", message: "Log in to Claude on the Watchdog page first (one-time)." };
    }
    if (source === "click" && confirmed !== true) {
      return { ok: false, code: "confirm_required", message: "Confirmation required before the first local session." };
    }
    if (source !== "click") {
      const floor = memoryFloorOk();
      if (!floor.ok) {
        warnLog(`unattended spawn skipped — ${floor.availableMb}MB available is under the floor`);
        return { ok: false, code: "memory_floor", message: `Skipped: only ${floor.availableMb}MB memory available.` };
      }
    }
    return runExclusive("start", async ({ generation: gen }) => {
      if (session?.phase === "running" && session.sessionUrl) {
        const liveness = session.hosting === "tmux" ? await isTmuxSessionAlive() : { alive: true };
        if (liveness.alive) {
          return { ok: true, status: "running", sessionId: session.sessionId, sessionUrl: session.sessionUrl };
        }
        await reapDeadTmuxSession().catch(() => {});
        session = null;
        persistSession();
      }
      if (session?.phase === "starting") {
        return { ok: true, status: "starting" };
      }
      // A retained failed session (url_extract_timeout diagnosis) never gets
      // re-adopted into a retry: kill first, then spawn fresh (its tail is
      // already persisted via lastError).
      if (session?.phase === "running_no_url") {
        if (session.hosting === "tmux") await reapDeadTmuxSession().catch(() => {});
        else {
          try {
            session.proc?.kill("SIGTERM");
          } catch {}
        }
        session = null;
        persistSession();
      }
      ensureDirs();
      if (probes?.tmuxOk) {
        const adopted = await adoptSession({ gen });
        if (adopted) {
          if (session?.sessionUrl) {
            return { ok: true, status: "running", sessionId: session.sessionId, sessionUrl: session.sessionUrl };
          }
          return { ok: false, code: "adopted_without_url", message: lastError?.message || "Adopted a session without a recoverable URL — stop and retry." };
        }
        const spawned = await spawnTmuxSession({ gen, source, useContinue: source === "autostart" });
        if (!spawned) return { ok: false, code: lastError?.code || "spawn_failed", message: lastError?.message };
        return { ok: true, status: "starting" };
      }
      if (hasScriptCommand()) {
        const spawned = await spawnScriptSession({ gen, source });
        if (!spawned) return { ok: false, code: lastError?.code || "spawn_failed", message: lastError?.message };
        return { ok: true, status: "starting" };
      }
      setError("hosting_unavailable", "Neither tmux nor script(1) is available — install tmux to host rescue sessions.", null);
      return { ok: false, code: "hosting_unavailable", message: lastError.message };
    });
  };

  const stopSession = async () =>
    runExclusive("stop", async () => {
      stopping = true;
      try {
        if (session?.hosting === "script") {
          try {
            session.proc?.kill("SIGTERM");
          } catch {}
        } else {
          await driver.killSession({ sessionName, env: buildRescueEnv() });
        }
        session = null;
        lastError = null;
        persistSession();
        log("stopped");
        return { ok: true };
      } finally {
        stopping = false;
      }
    });

  // ------------------------------------------------------------- login -----
  const watchLogin = async (gen) => {
    const deadline = nowFn() + intervals.loginTtlMs;
    while (nowFn() < deadline) {
      if (gen !== generation || !login || login.generation !== gen) return;
      const buffer = login.buffer;
      if (!login.oauthUrl) {
        const url = extractOauthUrl(buffer);
        if (url) {
          login.oauthUrl = url;
          login.phase = "awaiting_code";
          log("login: OAuth URL surfaced to the UI");
        }
      }
      if (login.phase === "verifying" || detectLoginSuccess(buffer)) {
        const probes = await refreshProbes({ force: true });
        if (gen !== generation || !login || login.generation !== gen) return;
        if (probes?.loggedIn) {
          try {
            login.proc?.kill("SIGTERM");
          } catch {}
          login = null;
          lastLogin = { phase: "success" };
          log("login: verified via claude auth status");
          return;
        }
      }
      if (detectLoginFailure(buffer)) {
        const tail = sanitizeText(buffer);
        try {
          login.proc?.kill("SIGTERM");
        } catch {}
        login = null;
        lastLogin = { phase: "failed", error: "The CLI rejected the login code.", tailSanitized: tail };
        warnLog("login: failed (CLI rejected the code)");
        return;
      }
      if (login.exited) {
        // Child gone without a detected verdict: auth status decides.
        const probes = await refreshProbes({ force: true });
        if (gen !== generation || !login || login.generation !== gen) return;
        const tail = sanitizeText(login.buffer);
        const succeeded = probes?.loggedIn === true;
        login = null;
        lastLogin = succeeded
          ? { phase: "success" }
          : { phase: "failed", error: "The login process exited before completing.", tailSanitized: tail };
        log(`login: process exited — ${succeeded ? "verified logged in" : "not logged in"}`);
        return;
      }
      await new Promise((r) => setTimeout(r, intervals.loginPollMs));
    }
    if (gen !== generation || !login || login.generation !== gen) return;
    const tail = sanitizeText(login.buffer);
    try {
      login.proc?.kill("SIGTERM");
    } catch {}
    login = null;
    lastLogin = { phase: "failed", error: "Login timed out after 10 minutes.", tailSanitized: tail };
    warnLog("login: timed out");
  };

  const startLogin = async () => {
    if (!isEnabled()) return { ok: false, code: "disabled", message: "Local rescue sessions are disabled." };
    const probes = await refreshProbes({ force: true });
    if (probes?.installed === false) {
      return { ok: false, code: "not_installed", message: "The claude CLI is not installed on this box." };
    }
    if (probes?.loggedIn === true) return { ok: false, code: "already_logged_in", message: "Already logged in." };
    if (login) return { ok: false, code: "login_in_progress", message: "A login is already in progress." };
    return runExclusive("login", async ({ generation: gen }) => {
      ensureDirs();
      let proc;
      try {
        // script(1) directly (not tmux): the OAuth URL and the pasted code
        // stay in THIS process's memory, never in tmux server scrollback.
        proc = spawnInPty(["claude", "auth", "login"], {
          cwd: dirs.home,
          env: buildRescueEnv(),
          spawnImpl,
        });
      } catch (error) {
        return { ok: false, code: "spawn_failed", message: `Could not start the login: ${error?.message}` };
      }
      login = {
        phase: "starting",
        proc,
        buffer: "",
        oauthUrl: null,
        startedAt: nowFn(),
        generation: gen,
        exited: false,
      };
      lastLogin = null;
      const append = (chunk) => {
        if (!login || login.generation !== gen) return;
        login.buffer = (login.buffer + String(chunk)).slice(-kLoginBufferMaxChars);
      };
      proc.stdout?.setEncoding("utf8");
      proc.stderr?.setEncoding("utf8");
      proc.stdout?.on("data", append);
      proc.stderr?.on("data", append);
      proc.on("error", () => {
        if (login?.generation === gen) login.exited = true;
      });
      proc.on("exit", () => {
        if (login?.generation === gen) login.exited = true;
      });
      watchLogin(gen).catch((error) => warnLog(`login watcher failed: ${error?.message}`));
      log("login: started");
      return { ok: true, status: "starting" };
    });
  };

  const submitLoginCode = async ({ code } = {}) => {
    const trimmed = String(code ?? "").trim();
    if (!trimmed) return { ok: false, code: "empty_code", message: "Paste the code from claude.ai." };
    if (trimmed.length > kLoginCodeMaxChars || /[^\x20-\x7e]/.test(trimmed)) {
      return { ok: false, code: "invalid_code", message: "That does not look like a login code." };
    }
    if (!login || !login.proc) {
      return { ok: false, code: "no_login_in_progress", message: "Start the login first." };
    }
    // The code is a short-lived credential: redact it from every tail and
    // log line for the rest of this process's life.
    loginCodeSecrets.push(trimmed);
    if (loginCodeSecrets.length > 8) loginCodeSecrets = loginCodeSecrets.slice(-8);
    try {
      login.proc.stdin?.write(`${trimmed}\n`);
    } catch (error) {
      return { ok: false, code: "write_failed", message: `Could not hand the code to the CLI: ${error?.message}` };
    }
    login.phase = "verifying";
    log("login: code submitted, verifying");
    return { ok: true, status: "verifying" };
  };

  const cancelLogin = async () => {
    if (!login) return { ok: true };
    try {
      login.proc?.kill("SIGTERM");
    } catch {}
    login = null;
    lastLogin = null;
    log("login: cancelled");
    return { ok: true };
  };

  const logout = async () => {
    if (session) {
      return { ok: false, code: "session_running", message: "Stop the rescue session before logging out." };
    }
    return runExclusive("logout", async () => {
      try {
        fsModule.rmSync(path.join(dirs.home, ".claude", ".credentials.json"), { force: true });
      } catch {}
      probeState = null;
      await refreshProbes({ force: true }).catch(() => {});
      log("logged out (credentials removed)");
      return { ok: true };
    });
  };

  // ------------------------------------------------------- incident hook ---
  // Fire-and-forget from the watchdog incident tracker: must NEVER affect
  // incident processing (own catch, one log line) and never queue behind a
  // held mutex (skip is the correct behavior mid-operation).
  const ensureForIncident = (context = {}) => {
    (async () => {
      if (!isEnabled() || !isSpawnOnIncident()) return;
      if (currentOp) return;
      const probes = probeState || (await refreshProbes().catch(() => null));
      if (!probes?.loggedIn) return;
      if (session?.phase === "running" || session?.phase === "starting") return;
      const label = context.incidentId ? `incident:${context.incidentId}` : "incident";
      const result = await startSession({ source: label });
      if (!result.ok && result.code !== "busy") {
        warnLog(`incident spawn skipped (${result.code})`);
      }
    })().catch((error) => {
      warnLog(`incident spawn failed: ${error?.message}`);
    });
  };

  // Read-only consult for the watchdog's notification composition: a line
  // only when the URL already exists (a cold spawn takes ~15-30s; the open
  // notification goes out without it, no follow-up — the URL lives on the
  // card and in the operator's claude.ai session list).
  const getNotificationLine = () => {
    if (session?.phase === "running" && session.sessionUrl) {
      return `🛟 Rescue session: ${session.sessionUrl}`;
    }
    return null;
  };

  // -------------------------------------------------------------- status ---
  // Ordered guard table, evaluated top-down (kept as data so the derivation
  // is testable row by row instead of nested if/else).
  const kStateGuards = [
    [() => !probeState, "probing"],
    [() => !isEnabled(), "disabled"],
    [() => probeState?.installed === false, "not_installed"],
    [() => Boolean(login), "login_in_progress"],
    [() => probeState?.loggedIn === false, "needs_login"],
    [() => stopping, "stopping"],
    [() => session?.phase === "starting", "starting"],
    [() => session?.phase === "running" && Boolean(session.sessionUrl), "running"],
    [() => session?.phase === "running_no_url", "error"],
    [() => Boolean(lastError), "error"],
    [() => true, "ready"],
  ];

  const getStatusSnapshot = () => {
    const state = kStateGuards.find(([guard]) => {
      try {
        return guard();
      } catch {
        return false;
      }
    })[1];
    const warnings = [];
    if (probeState?.versionWarning) warnings.push(probeState.versionWarning);
    if (probeState && probeState.tmuxOk === false) {
      warnings.push("tmux is not installed — sessions use script(1) hosting and die with AlphaClaw");
    }
    if (session?.warnings?.length) warnings.push(...session.warnings);
    if (!isEnabled() && session) {
      warnings.push("Local rescue is disabled but a session is still live — stop it from this card.");
    }
    const snapshot = {
      enabled: isEnabled(),
      state,
      hosting: session?.hosting || (probeState?.tmuxOk ? "tmux" : probeState ? "script" : null),
      claudeVersion: probeState?.claudeVersion || null,
      sessionName,
      sessionUrl: state === "running" ? session.sessionUrl : null,
      sessionId: state === "running" ? session.sessionId : null,
      permissionMode: configuredPermissionMode(),
      livePermissionMode: session?.mode || null,
      autostart: isAutostart(),
      spawnOnIncident: isSpawnOnIncident(),
      cwd: session?.cwd || configuredCwd(),
      startedAt: session?.startedAt || null,
      spawnedBy: session?.spawnedBy || null,
      socketPath: dirs.socket,
      warnings,
      freshAt: probeState?.at || null,
    };
    if (login || lastLogin) {
      snapshot.login = login
        ? { phase: login.phase, oauthUrl: login.oauthUrl }
        : { phase: lastLogin.phase, error: lastLogin.error || null };
    }
    if (state === "error" && lastError) {
      snapshot.error = {
        code: lastError.code,
        message: lastError.message,
        tailSanitized: lastError.tailSanitized,
      };
    }
    return snapshot;
  };

  const getTail = async ({ source = "session" } = {}) => {
    if (source === "login") {
      const buffer = login?.buffer || lastLogin?.tailSanitized || "";
      if (!buffer) return { ok: false, code: "no_buffer" };
      return { ok: true, source, tail: login ? sanitizeText(buffer) : buffer };
    }
    if (session?.hosting === "script") {
      return { ok: true, source, tail: sanitizeText(session.buffer || "") };
    }
    if (session?.hosting === "tmux") {
      const buffer = await driver.capturePane({ sessionName, lines: 400, env: buildRescueEnv() });
      if (buffer != null) return { ok: true, source, tail: sanitizeText(buffer) };
    }
    if (lastError?.tailSanitized) return { ok: true, source, tail: lastError.tailSanitized };
    if (lastExitTail) return { ok: true, source, tail: lastExitTail };
    return { ok: false, code: "no_buffer" };
  };

  // ---------------------------------------------------------------- boot ---
  const reconcileOnBoot = () => {
    (async () => {
      await refreshProbes({ force: true });
      if (!isEnabled()) return;
      const adopted = await runExclusive("boot-reconcile", async ({ generation: gen }) => {
        if (!probeState?.tmuxOk) return false;
        return adoptSession({ gen });
      });
      if (adopted === true) return;
      if (
        isAutostart() &&
        probeState?.installed &&
        probeState?.loggedIn &&
        !session
      ) {
        const result = await startSession({ source: "autostart" });
        if (!result.ok && result.code !== "busy") {
          warnLog(`autostart skipped (${result.code})`);
        }
      }
    })()
      .catch((error) => warnLog(`boot reconcile failed: ${error?.message}`))
      .finally(() => {
        if (disposed) return;
        probeTimer = setInterval(() => {
          refreshProbes().catch(() => {});
        }, intervals.probeMs);
        probeTimer.unref?.();
      });
  };

  const dispose = () => {
    disposed = true;
    if (probeTimer) clearInterval(probeTimer);
    probeTimer = null;
    try {
      login?.proc?.kill("SIGTERM");
    } catch {}
    login = null;
    // Script-hosted children die with us anyway (pipe lifetime) — reap
    // cleanly; tmux sessions are deliberately left running (that is the
    // feature).
    if (session?.hosting === "script") {
      try {
        session.proc?.kill("SIGTERM");
      } catch {}
    }
  };

  return {
    startSession,
    stopSession,
    startLogin,
    submitLoginCode,
    cancelLogin,
    logout,
    getStatusSnapshot,
    getTail,
    ensureForIncident,
    getNotificationLine,
    reconcileOnBoot,
    refreshProbes,
    dispose,
    // exposed for tests
    _internals: { buildRescueEnv, buildSpawnCommand, sanitizeText },
  };
};

module.exports = { createClaudeCodeLocalService };
