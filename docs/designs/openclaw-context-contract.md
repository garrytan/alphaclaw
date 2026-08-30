# OpenClaw Context Contract — verified from npm tarballs

Durable record of the OpenClaw workspace-context, doctor-CLI, and lifecycle contracts that
AlphaClaw's Drift Doctor, watchdog, and supervisor code depend on. Every fact below was
verified by reading the actual published npm tarballs — not docs, not assumptions:

| Line | Package | Extracted at (planning pass) | Re-fetch |
|------|---------|------------------------------|----------|
| stable | `openclaw@2026.7.1-2` | `/tmp/oc-stable/package` | `npm pack openclaw@2026.7.1-2` |
| beta | `openclaw@2026.8.1-beta.3` | `/tmp/oc-beta/package` | `npm pack openclaw@2026.8.1-beta.3` |
| beta (gate floor) | `openclaw@2026.8.1-beta.1` | `/tmp/oc-beta1/package` | `npm pack openclaw@2026.8.1-beta.1` |

Citations are `package version → dist file → symbol`. Dist chunk names are content-hashed and
change per release; the symbol names are the stable handle. The machine-checked mirror of this
document is `lib/server/doctor/context-profiles.js` plus its fact-snapshot tests (golden
fixtures labeled with package versions — durable after `/tmp` disappears).

## 1. Bootstrap injection contract

### Injected file set and order

Later files starve first: the allocator walks files in order and stops when the total budget
runs out (`buildBootstrapContextFiles`; beta `dist/bootstrap-CaqLzAOR.js`, stable
`dist/embedded-agent-helpers-DZZ4Y-Tw.js`). AlphaClaw's `bootstrap-extra-files` extras are
appended AFTER the core files on both lines, so they starve before anything else.

| Order | stable 2026.7.1-2 | beta 2026.8.1 |
|-------|-------------------|---------------|
| 1 | AGENTS.md | AGENTS.md |
| 2 | SOUL.md | SOUL.md |
| 3 | TOOLS.md | IDENTITY.md |
| 4 | IDENTITY.md | USER.md |
| 5 | USER.md | BOOTSTRAP.md |
| 6 | HEARTBEAT.md | MEMORY.md |
| 7 | BOOTSTRAP.md | *(extras last)* |
| 8 | MEMORY.md | |
| 9 | *(extras last)* | |

Cited: stable `dist/workspace-DkQ7irPD.js` `loadWorkspaceBootstrapFiles` (lines 740-772);
beta `dist/workspace-D59tUhZX.js` `loadWorkspaceBootstrapFiles` +
`WORKSPACE_BOOTSTRAP_FILENAMES` (line 252).

Absent-file handling: a missing root file still injects a visible marker rendered as
`[MISSING] Expected at: <absolute path>`, and the marker's length is **charged to the total
budget**. The allocator's missing branch runs BEFORE the 64-char minimum-budget check, so the
marker is exempt from both the per-file cap and that floor — it is only clamped to the
remaining total budget (`clampToBudget(`` `[MISSING] Expected at: ${pathValue}` ``,
remainingTotalChars)`; once the allocator breaks — total exhausted or the <64 floor hit by a
content file — later markers are not rendered either). Omitted entirely instead (no entry, no
marker): stable skips only `MEMORY.md` when absent; beta skips both `MEMORY.md` and `USER.md`
(case-exact `exactWorkspaceEntryExists` check — a lowercase `memory.md` does not count).
Extras never produce markers: `loadWorkspacePatternFilesWithDiagnostics` only appends files it
actually read (a missing extra becomes a diagnostic, not a bootstrap entry).
Cited: stable `dist/embedded-agent-helpers-DZZ4Y-Tw.js` `buildBootstrapContextFiles`; beta
`dist/bootstrap-CaqLzAOR.js` (same symbol, identical marker template).

`BOOTSTRAP.md` is gated by workspace-setup-completed state on BOTH lines — there is no
`injectMode` / `first_run_only` concept and there never was
(`filterCompletedWorkspaceBootstrapFile` + `isWorkspaceSetupCompleted`; stable
`dist/bootstrap-files-CUlAj8PH.js`, beta `dist/bootstrap-files-ClZNlibt.js`).

### Budgets

| Constant | Value | Lines | Cited symbol |
|----------|-------|-------|--------------|
| Per-file cap | 20,000 chars | both | `DEFAULT_BOOTSTRAP_MAX_CHARS = 2e4` |
| Total cap | 60,000 chars | both | `DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 6e4` |
| USER.md hard cap | 4,000 chars | beta only | `USER_BOOTSTRAP_MAX_CHARS = 4e3`, applied as `Math.min(maxChars, USER_BOOTSTRAP_MAX_CHARS)` — by BASENAME, case-insensitively (`effectiveBootstrapFileLimit` / `isUserBootstrapFile`: `name.toLowerCase() === "user.md"` where `name` is the basename), so an extras entry like `hooks/bootstrap/USER.md` gets the same cap |
| Near-limit ratio | 0.85 | both | `DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO = .85` / `NEAR_LIMIT_RATIO = .85` |
| Min file budget | 64 chars | both | `MIN_BOOTSTRAP_FILE_BUDGET_CHARS = 64` — remaining total budget below this skips all further files |
| Raw read cap | 2 MiB | both | `MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024` |

Cited: stable `dist/embedded-agent-helpers-DZZ4Y-Tw.js` (per-file/total/min),
`dist/bootstrap-budget-DFC5I5_X.js` (near-limit), `dist/workspace-DkQ7irPD.js:132` (2 MiB);
beta `dist/bootstrap-CaqLzAOR.js` (per-file/total/min/USER cap at line 252),
`dist/bootstrap-budget-RyMqGFrH.js` (near-limit),
`dist/workspace-bootstrap-read-BUXIGyyB.js:3` (2 MiB).
Config overrides: `agents.defaults.bootstrapMaxChars` / `agents.defaults.bootstrapTotalMaxChars`
(beta `docs/concepts/agent-workspace.md`); the USER 4k cap is NOT configurable.

The 2 MiB raw read cap REJECTS the whole read — it never truncates (unlike the char budgets
above): stable's guarded open fails validation outright on `stat.size > maxBytes`
(`dist/pinned-open-CED4V9Dl.js` via `dist/root-file-9jkyxRTl.js` `openRootFile`); beta's bounded
descriptor read throws `too-large` → `RangeError` past the cap
(`dist/bounded-read-pTKvsUkY.js`, `dist/boundary-file-read-DV113rom.js`
`preserveOpenClawOverflowError`). The same guarded open also rejects paths whose resolved real
path escapes the workspace (symlinks included; `rejectSymlinks` defaults true — beta follows
contained PARENT symlinks only, `openRootFileFollowingParents`). Downstream treatment of a
rejected read: extras are OMITTED with a `security` diagnostic (both lines,
`loadExtraBootstrapFilesWithDiagnostics`); core root files model `missing: true` on stable
(`dist/workspace-DkQ7irPD.js`) while beta injects a short `[UNREADABLE: <reason>]` marker
instead of the content (`dist/workspace-D59tUhZX.js` `loadWorkspaceBootstrapFiles`). Drift
Doctor mirrors this in `lib/server/doctor/bootstrap-context.js`
(`kDoctorBootstrapReadMaxBytes`): rejected files model as not injected — extras carry
`escapes_workspace` / `file_too_large`, root files fall back to the missing-marker path.

Per-agent precedence (both lines): `resolveBootstrapMaxChars(cfg, agentId)` /
`resolveBootstrapTotalMaxChars(cfg, agentId)` read
`resolveAgentConfig(cfg, agentId)?.bootstrap[Total]MaxChars ?? cfg.agents?.defaults?.…`, then a
single validation ladder (`typeof raw === "number" && Number.isFinite(raw) && raw > 0` →
`Math.floor(raw)`, else the built-in default). So a "main" roster entry's value beats
`agents.defaults` — and a non-nullish but INVALID per-agent value (0, negative, string) fails
validation and lands on the built-in default, NOT on `agents.defaults`. The roster is
`agents.entries` (object map keyed by agent id) when that property exists, else `agents.list`
(array of entries with `.id`); with no roster property, main is implicit with no overrides.
Cited: beta `dist/bootstrap-CaqLzAOR.js` (`resolveBootstrapMaxChars`,
`resolveBootstrapTotalMaxChars`) + `dist/agent-scope-config-CKOJa4MC.js` (`resolveAgentEntry`,
`readAgentRosterProperty`, `resolveAgentConfig`); stable
`dist/embedded-agent-helpers-DZZ4Y-Tw.js` (same resolver ladder) +
`dist/agent-scope-config-BxAUeF6t.js` (`agents.list`-only roster). Drift Doctor models the MAIN
session, so the analyzer resolves the effective budgets for agent id `main`
(`lib/server/doctor/bootstrap-context.js` `resolveMainBootstrapBudget`).

### Truncation algorithm (identical symbols on both lines)

- Default: keep **75% head / 25% tail** (`BOOTSTRAP_HEAD_RATIO = .75`) with a visible in-file
  marker: `` [...truncated, read <file> for full content...] `` plus
  `…(truncated <file>: kept <head>+<tail> chars of <total>)…` (compact fallback
  `[…truncated <head>+<tail>/<total>]`).
- `AGENTS.md` special-case: **45% head + 35% policy digest + 15% tail**
  (`AGENTS_POLICY_HEAD_RATIO = .45`, `AGENTS_POLICY_DIGEST_RATIO = .35`; tail is the
  remainder), marker `…(truncated AGENTS.md: kept <head>+policy <digest>+<tail> chars of <total>)…`.
- An agent-visible `[Bootstrap truncation warning]` block is appended to the prompt whenever
  truncation occurred: default warning mode is `"always"`
  (`DEFAULT_BOOTSTRAP_PROMPT_TRUNCATION_WARNING_MODE = "always"`; other modes dedupe by
  truncation signature or turn it off). Block text: "Some workspace bootstrap files were
  truncated before injection. / Treat Project Context as partial and read the relevant files
  directly if details seem missing." plus per-file `raw -> injected (~N% removed)` lines and an
  extra caution line when AGENTS.md was truncated.

Cited: stable `dist/embedded-agent-helpers-DZZ4Y-Tw.js` (ratios, markers, warning mode) +
`dist/bootstrap-budget-DFC5I5_X.js` (`appendBootstrapPromptWarning`,
`formatBootstrapTruncationWarningLines`); beta `dist/bootstrap-CaqLzAOR.js` +
`dist/bootstrap-budget-RyMqGFrH.js` (same symbols).

### `VALID_BOOTSTRAP_NAMES` (accepted basenames, incl. extras)

| stable 2026.7.1-2 (8 names) | beta 2026.8.1 (6 names) |
|-----------------------------|--------------------------|
| AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md | AGENTS.md, SOUL.md, IDENTITY.md, USER.md, BOOTSTRAP.md, MEMORY.md |

Cited: stable `dist/workspace-DkQ7irPD.js` `VALID_BOOTSTRAP_NAMES`; beta
`dist/workspace-D59tUhZX.js` `VALID_BOOTSTRAP_NAMES = new Set(WORKSPACE_BOOTSTRAP_FILENAMES)`.
`AGENTS.md` is a valid extras basename on both — this is what makes AlphaClaw's unconditional
hardening merge (PR 6 of the 8.1 wave) safe on every version.

### `bootstrap-extra-files` hook

- Config entry shape: `hooks.internal.entries["bootstrap-extra-files"] = { enabled, paths }`
  (AlphaClaw writer: `lib/server/onboarding/openclaw.js`); extras count only when BOTH
  `hooks.internal.enabled` and the entry's own `enabled` are true.
- Paths must resolve inside the workspace: a pattern escaping the workspace is dropped with a
  `security` diagnostic ("pattern resolves outside the workspace"). Glob patterns supported.
- Basename allowlist is `VALID_BOOTSTRAP_NAMES`; a rejected basename emits an
  `invalid-bootstrap-filename` diagnostic ("unsupported bootstrap basename: <name>").
- Extras are appended AFTER the core files — they starve first under the 60k total budget.

Cited: beta `dist/workspace-D59tUhZX.js` `loadExtraBootstrapFilesWithDiagnostics` /
`loadWorkspacePatternFilesWithDiagnostics` (lines 900-978); stable equivalent in
`dist/workspace-DkQ7irPD.js` (same function names).

## 2. Beta-only deltas (2026.8.1 line)

Present since `2026.8.1-beta.1`: the 6-name set, the 60k total, and the USER 4k cap are all in
beta.1's dist (`dist/workspace-D9MnI_Ix.js`, `dist/bootstrap-b_Fz07I5.js`) — the
`bootstrapContractV2` feature gate is correctly pinned at beta.1.

### TOOLS.md / HEARTBEAT.md retirement

- Not injected, not seeded, and not accepted extras basenames (rejected with
  `invalid-bootstrap-filename`).
- Retirement notices ship in the tarball: `docs/reference/templates/TOOLS.md` ("TOOLS.md is
  retired") and `docs/reference/templates/HEARTBEAT.md` ("Heartbeat instructions now live in
  the system-owned monitor's cron scratch in the shared state database"; manage via
  `openclaw cron scratch <jobId>`).
- `openclaw doctor --fix` migrates: workspace TOOLS.md into AGENTS.md's `## Tools` section;
  HEARTBEAT.md instructions into monitor cron scratch (legacy `tasks:` entries become cron
  jobs; original archived under the state directory). Doctor check id:
  `core/doctor/tools-md-migration` (`dist/doctor-tools-md-migration-C42L8YgU.js`).

### Memory-origin eligibility gate

Before injection, `MEMORY.md` and `USER.md` candidates are classified by memory-runtime
provenance (`classifyActiveMemoryWorkspacePaths`); files whose origin class is not eligible for
automatic injection are excluded. Fail-safe: classification errors or an unsupported runtime
exclude the candidates (`resolveIneligibleAutomaticMemoryFiles`,
beta `dist/bootstrap-files-ClZNlibt.js` lines 145-175).

### Session-scope matrix

| Session kind | stable 2026.7.1-2 | beta 2026.8.1 |
|--------------|-------------------|---------------|
| subagent | AGENTS.md + TOOLS.md (`SUBAGENT_BOOTSTRAP_ALLOWLIST`) | AGENTS.md only |
| cron | AGENTS.md, TOOLS.md, SOUL.md, IDENTITY.md, USER.md (`CRON_BOOTSTRAP_ALLOWLIST` — **HEARTBEAT.md is NOT in it**) | AGENTS.md, SOUL.md, IDENTITY.md, USER.md |
| group / channel chat | no filtering (full set incl. MEMORY.md) | root MEMORY.md stripped (`filterRootMemoryBootstrapFiles`) |
| subagent / cron (additionally, beta) | — | root MEMORY.md stripped before the allowlist |

Cited: stable `dist/workspace-DkQ7irPD.js` `filterBootstrapFilesForSession` +
both allowlists (lines 797-808); beta `dist/workspace-D59tUhZX.js`
`filterBootstrapFilesForSession` + `filterRootMemoryBootstrapFiles` (lines 805-835).
Note (correction vs. earlier planning assumption): the stable cron allowlist does NOT include
HEARTBEAT.md; on stable, HEARTBEAT.md exclusion is a separate per-caller flag
(`filterHeartbeatBootstrapFile`, `dist/bootstrap-files-CUlAj8PH.js:154`).

## 3. `openclaw doctor` machine surface

**`openclaw doctor --lint --json` is THE cross-version read-only invocation.** Never invoke
bare `--json`:

- stable 2026.7.1-2: `--json` is "With --lint or --post-upgrade: emit machine-readable JSON
  output" — bare `--json` does nothing lint-like
  (`dist/register.maintenance-Br5Zg4ng.js`, doctor command registration).
- beta 2026.8.1: `--json` is "Emit JSON; bare --json runs advisory read-only health checks" —
  bare `--json` implies lint (`jsonImpliesLint`, `dist/register.maintenance-DZtYWZSZ.js:43`),
  BUT it then forces exit 0 regardless of findings (`exit(jsonImpliesLint ? 0 : exitCode)`),
  so even on beta only `--lint --json` gives the real exit-code contract.

JSON shape (stable `dist/doctor-lint-EQmIy7x0.js` `writeJsonResult`; beta
`dist/doctor-lint-Bu0wUumm.js`):

```json
{
  "ok": true,
  "checksRun": 12,
  "checksSkipped": 1,
  "findings": [
    { "checkId": "...", "severity": "info|warning|error", "message": "...",
      "path": "...?", "line": 1, "column": 1, "ocPath": "...?", "fixHint": "...?" }
  ]
}
```

Severity is a closed set (`parseHealthFindingSeverity`, `dist/doctor-lint-flow-FyLb6mCf.js`).
Exit codes with `--lint`: **0** = no findings at/above `--severity-min` (default `warning`),
**1** = findings at/above threshold (`exitCodeFromFindings`), **2** = runtime failure or
invalid option combination (catch handlers in both `register.maintenance` chunks). Parse
stdout regardless of exit code; treat 2 as "no result".

## 4. Memory and compaction doctrine (beta docs + dist)

- `MEMORY.md` = curated long-term memory, injected when present (main private session only).
  When it nears/exceeds budget, distill details into `memory/YYYY-MM-DD[-<slug>].md` dailies —
  those are never bootstrap-injected; agents retrieve them on demand via the `memory_search` /
  `memory_get` tools (`dist/client-By5bS5iv.js`,
  `dist/memory-core-host-engine-sessions-BEckg0en.js`). Exception: today's + yesterday's
  dailies auto-load as startup context on a bare `/new` or `/reset`
  (`docs/concepts/memory.md:24`; `shouldApplyStartupContext` honors
  `agents.defaults.startupContext.{enabled,applyOn}`, caps
  `STARTUP_MEMORY_TOTAL_MAX_CHARS_CAP = 5e4` / 14 days, `dist/get-reply-CbIpR5l-.js`).
- Lowercase `memory.md` = legacy repair input only: doctor offers "Merge legacy root memory.md
  into canonical MEMORY.md and remove the shadowed file"
  (`dist/doctor-workspace-BRbvVpi8.js`); the loader's case-exact check never injects it.
- `USER.md` = dated directives that supersede in place: "mark the old entry `superseded` and
  rewrite the active directive in place. Never append a contradictory active directive"
  (`docs/reference/templates/USER.md`). `SOUL.md` = voice/persona; `AGENTS.md` = operating
  rules (`docs/reference/templates/SOUL.md`, `AGENTS.md`).
- Compaction: new configs default to mode `"safeguard"` — `applyCompactionDefaults` seeds
  `agents.defaults.compaction.mode = "safeguard"` whenever no mode is set, and a configured
  compaction provider forces safeguard (`dist/io-Bs4954lU.js`,
  `dist/openclaw-runtime-DyaQKVOr.js` `resolveEffectiveCompactionMode`).
- Session pruning: `agents.defaults.contextPruning.mode = "cache-ttl"` prunes against the
  provider prompt-cache TTL, gated on cache-TTL-eligible providers
  (`dist/attempt-thread-helpers-DIAprGyj.js:36`).
- Skills prompt limits: `DEFAULT_MAX_SKILLS_IN_PROMPT = 150`,
  `DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18e3` (`dist/skill-prompt-limits-CDRegxQK.js`); each
  entry wraps in an `<available_skills>`/`<skill>` XML envelope
  (`formatSkillsForPromptCore`, `dist/skill-contract-6Z2EHE_Q.js`) costing ~97 chars of
  overhead per skill (estimate) on top of name/description/location; over-limit catalogs fall
  back to a compact format with a visible "Skills truncated" note.

## 5. Lifecycle appendix (beta 2026.8.1)

### Exit-78 trichotomy

Exit code 78 (EX_CONFIG) is overloaded — three distinct causes
(`dist/run-Bts2lL4H.js:1115,1225`; `dist/systemd-unit-DRc8gCH8.js:52` writes
`RestartPreventExitStatus=78` into the unit so systemd stops on purpose):

1. **Config error** (invalid config, or a required DB media/schema migration): genuinely
   broken — AlphaClaw's watchdog latches `configuration_error` and (with auto-repair on) runs
   `openclaw doctor --fix` once, then retries.
2. **Healthy-incumbent step-aside**: gateway lock / EADDRINUSE conflict where the existing
   gateway probes healthy — under systemd the newcomer exits 78 deliberately "to prevent a
   systemd Restart=always loop" (`SupervisedGatewayLockError`; exact stderr wording carries
   both "existing gateway is healthy" and "exiting with code 78"). Benign; must not latch,
   roll back, or notify. Nuance (verified in `dist/supervisor-markers-CooPyJZl.js` +
   `run-Bts2lL4H.js`): this branch fires only when upstream detects `supervisor === "systemd"`
   via env hints (`OPENCLAW_SYSTEMD_UNIT`, `INVOCATION_ID`, `SYSTEMD_EXEC_PID`,
   `JOURNAL_STREAM`); under other/no detected supervisors the healthy-incumbent path logs
   "leaving it in control" and exits **0**, and `OPENCLAW_SUPERVISOR_MODE=external` alone
   does not select the exit-78 branch.
3. **Tailscale :443 route-ownership conflict** (`isTailscaleRouteOwnershipConflictError`
   mapped to `EXIT_CONFIG_ERROR`).

### Health probes

Route map (`dist/gateway-http-route-contracts-ByqHS7gV.js` `GATEWAY_PROBE_ROUTES`):
`/health` + `/healthz` → live (always 200 when the process serves), `/ready` + `/readyz` →
ready, `/startup` + `/startupz` → startup (new in this line). Ready semantics
(`dist/server-start-DfdXe4Up.js`, `readiness.ts` + `handleGatewayProbeRequest`):

- 200 when ready, 503 when not; details are gated by `shouldIncludeGatewayProbeDetails` —
  an unauthenticated/untrusted remote gets `{ready}` ONLY.
- Detailed payload: `{ready, failing[], uptimeMs, ...}` where `failing[]` values include
  `startup-sidecars` (startup pending), `gateway-draining`, and `internal` (readiness checker
  threw). The `suppressed` key is OMITTED when empty
  (`...suppressed.length > 0 ? { suppressed } : {}`).

### Restart-handoff protocol v1

When externally supervised, a gateway restart request (config-write restart, `/restart`,
SIGUSR1, plugin change — including exits AlphaClaw did not initiate) writes a handoff row and
the process exits **0**; the supervisor decides whether to relaunch.

- Store: SQLite table `gateway_restart_handoff` in the shared state DB
  (`dist/openclaw-state-db-CJ70xZVI.js`), TTL `GATEWAY_RESTART_HANDOFF_TTL_MS = 6e4` (60s,
  also the clamp ceiling; `dist/restart-handoff-BIrSjjgl.js:12,67`).
- Hidden CLI (`dist/gateway-cli-CtbG05MB.js`):
  - `openclaw gateway restart-handoff capabilities [--json]` →
    `{ok, protocol: "openclaw.gateway.restart-handoff", protocolVersion: 1, operations: ["consume"]}`.
  - `openclaw gateway restart-handoff consume --expected-pid <pid> [--json]` → exit **0** even
    for `status: "none"` / `"rejected"`; **1** = store-unavailable; **2** = invalid-expected-pid.
- Consume is destructive and atomic (`consumeGatewayRestartHandoffSync`,
  `dist/restart-handoff-BIrSjjgl.js:228`): `accepted` deletes the row; `rejected/invalid` and
  `rejected/expired` also delete it; `rejected/pid-mismatch` RETAINS the row (another
  supervisor may hold the right PID). Consume at most once per exited PID.

### External supervision mode

`OPENCLAW_SUPERVISOR_MODE=external` (`dist/gateway-supervision-DzYBJaT5.js:4`) marks the
shared state DB as externally supervised; native service mutation and self-update paths refuse
to act on an externally supervised install unless run under that mode
(`dist/update-startup-D_wVRqqN.js:507`, `dist/register.database-CkXLy-I8.js:77`).

### `backup sqlite` CLI (`dist/register.backup-DmjgffC2.js:2587-2617`)

- `openclaw backup sqlite create` — scope is REQUIRED: exactly one of `--global` or
  `--agent <id>`, plus required `--repository <path>`; `--json` output is
  `{ok, snapshotPath, manifest}` where `snapshotPath` is the created snapshot directory.
  There is **NO `--verify` flag** on create.
- Verification is a separate subcommand: `openclaw backup sqlite verify <snapshotDir> [--json]`.
  Also: `list --repository`, `restore <snapshot> --target <freshPath>`.

### Dashboards focus deep links

Path-form only: `/focus/dashboard/<agentId>[/<sessionRef>]` — `/focus` is a routing namespace
segment (`FOCUS_SEGMENT = "/focus"`, `dist/control-ui-routing-ZPtw_aQu.js`,
`packages/session-url-contract/src/focus.ts`) composed with the session path grammar
`/{chat|dashboard}/<agent>[/<ref>]` (per-segment `encodeURIComponent`, `~key` escape for
literal session keys; `parseControlUiSessionPath`, `dist/session-ref-D0jeEavD.js`). No
`?focus=` query form is parsed anywhere in the dist.

## 6. Re-verification checklist

Run this on EVERY upstream release adoption (stable pin bump, beta adoption, channel change):

1. Fetch and extract the exact tarballs:
   ```sh
   cd /tmp && npm pack openclaw@<version>
   mkdir -p oc-<label> && tar -xzf openclaw-<version>.tgz -C oc-<label>
   # e.g. npm pack openclaw@2026.7.1-2 ; npm pack openclaw@2026.8.1-beta.3
   ```
2. Re-verify every cited fact in this document by grepping the new dist (chunk hashes change;
   search by symbol name: `VALID_BOOTSTRAP_NAMES`, `DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS`,
   `resolveBootstrapMaxChars` (per-agent precedence: `resolveAgentEntry` /
   `readAgentRosterProperty` roster shapes and the number-only validation ladder),
   `CRON_BOOTSTRAP_ALLOWLIST`, `jsonImpliesLint`, `GATEWAY_RESTART_HANDOFF_TTL_MS`,
   `GATEWAY_PROBE_ROUTES`, ...).
3. Add or raise the context profiles in `lib/server/doctor/context-profiles.js` as needed
   (new profile for a contract change; raise the feature-gate minimum when a fact landed later
   in a release line). The profile fact-snapshot tests are the checked-in golden fixtures —
   update them together with the profile, never independently.
4. Update this document: adjust the version table above, and re-confirm or amend each cited
   dist filename/symbol.
5. Live tier (`OPENCLAW_LIVE_E2E=1`) re-runs the CLI-contract assertions:
   `doctor --lint --json` schema, `backup sqlite create → verify` cycle,
   `gateway restart-handoff capabilities --json` protocol.
