#!/bin/bash
# Browser-level E2E smoke for the sidebar Claude Code launcher — a REAL server
# driven by a REAL headless Chromium, asserting the rendered DOM and the full
# request path (browser → session auth → route → service). Phases 1-4 never
# bill: the configured phase uses shape-valid FAKE credentials, so the one real
# outbound fire attempt is rejected by api.anthropic.com (or by the network)
# and lands on the error-toast path — which is exactly the assertion.
#
# Opt-in like tests/live/**: needs the gstack browse CLI (or set BROWSE_BIN)
# and Node from AlphaClaw's supported matrix. NOT part of `npm test`; run it
# by hand (or `npm run test:ui:claude-code`):
#
#   BROWSE_BIN=~/.claude/skills/gstack/browse/dist/browse tests/browser/claude-code-launcher-smoke.sh
#
# Covers, end to end in a real browser:
#   1. unconfigured: item renders as a plain external link (no live-dot),
#      status reports not_configured, an unconfirmed fire is refused
#   2. env hot-reload: appending the two vars to .env flips status live,
#      with no server restart
#   3. configured: live-dot + tooltip flip; plain click raises the one-time
#      confirmation modal (server-enforced confirm_required); Cancel closes it
#   4. Start: consent flag persists to localStorage, the fire goes out for
#      real and fails honestly (fake token) → 10s error toast, and the modal
#      never reappears on later clicks
#   5. (opt-in, issue #76 B4 / Codex D19) the LOCAL rescue session starts
#      informed: a fixture-pinned INCIDENT-<id>.md + the managed CLAUDE.md are
#      seeded into the service's managed workspace (by the same writer the
#      incident hook uses), a real `claude remote-control` session is spawned
#      through the real route, and a one-shot `claude -p` run in that same
#      pre-trusted workspace/HOME must acknowledge the pinned bundle filename —
#      proving the managed CLAUDE.md routes a fresh session to the evidence.
#      Skipped unless ALL of these hold (it needs a logged-in CLI and bills one
#      short turn):
#
#        CC_SMOKE_RESCUE=1 \
#        CC_SMOKE_CLAUDE_CREDENTIALS=~/.claude/.credentials.json \
#        BROWSE_BIN=… tests/browser/claude-code-launcher-smoke.sh
#
#      (the credentials file of a HOME where `claude auth login` succeeded)
#      plus `claude` and `tmux` on PATH. The credentials file is COPIED into
#      the scratch root's dedicated rescue HOME (never read in place) and the
#      scratch root is removed on exit.
set -euo pipefail

kPort="${UI_SMOKE_PORT:-3798}"
kPass="cc-smoke-pass"
B="${BROWSE_BIN:-$HOME/.claude/skills/gstack/browse/dist/browse}"
kRepoRoot="$(cd "$(dirname "$0")/../.." && pwd)"
# Read by the phase-5 node heredoc (quoted heredoc: no shell interpolation).
export kRepoRootForNode="$kRepoRoot"

if [ ! -x "$B" ]; then
  echo "SKIP: browse CLI not found at $B (set BROWSE_BIN)" >&2
  exit 0
fi

kScratch="$(mktemp -d /tmp/alphaclaw-cc-smoke-XXXXXX)"
cleanup() {
  # Never `kill 0` (fix wave F181): with no server pid recorded the old
  # `${kServerPid:-0}` fallback killed the caller's whole process group.
  if [ -n "${kServerPid:-}" ] && [ "${kServerPid}" != "0" ]; then
    kill "${kServerPid}" 2>/dev/null || true
  fi
  wait "${kServerPid:-0}" 2>/dev/null || true
  rm -rf "$kScratch" 2>/dev/null || true
}
trap cleanup EXIT

# Minimal onboarded fixture (same shape as upgrade-ui-smoke.sh). The launcher
# vars are deliberately ABSENT at boot: phase 2 appends them to test the
# live .env reload.
mkdir -p "$kScratch/.openclaw"
echo '{"onboardedAt": 0, "source": "cc-smoke"}' > "$kScratch/onboarded.json"
echo '{"gateway": {"mode": "local", "port": 18997, "auth": {"token": "${OPENCLAW_GATEWAY_TOKEN}"}}}' \
  > "$kScratch/.openclaw/openclaw.json"
echo "SETUP_PASSWORD=$kPass" > "$kScratch/.env"

# Phase 5 prerequisites (decided BEFORE the server boots: the rescue service
# probes `claude auth status` under its dedicated HOME at startup, so the
# credentials must already be in place). The pinned fixture: the incident id
# and the acknowledgement token are constants here; the bundle CONTENT comes
# from the production writer (lib/server/claude-code-local/incident-bundle.js).
kRescueHome="$kScratch/claude-code-local/home"
kRescueWorkspace="$kScratch/claude-code-local/workspace"
kRescueIncidentId="smoke-4242"
kRescueBundleName="INCIDENT-$kRescueIncidentId.md"
kRescuePhase="skip"
kRescueSkipReason=""
if [ "${CC_SMOKE_RESCUE:-0}" = "1" ]; then
  if ! command -v claude >/dev/null 2>&1; then
    kRescueSkipReason="claude CLI not on PATH"
  elif ! command -v tmux >/dev/null 2>&1; then
    kRescueSkipReason="tmux not on PATH"
  elif [ -z "${CC_SMOKE_CLAUDE_CREDENTIALS:-}" ] || [ ! -r "${CC_SMOKE_CLAUDE_CREDENTIALS:-/nonexistent}" ]; then
    kRescueSkipReason="CC_SMOKE_CLAUDE_CREDENTIALS must point at a readable, logged-in .credentials.json"
  else
    kRescuePhase="run"
    # The service's dedicated HOME: 0700 like the service creates it, with the
    # operator's OAuth credential copied in (Remote Control refuses API keys).
    mkdir -p -m 700 "$kRescueHome/.claude" "$kRescueWorkspace"
    cp "$CC_SMOKE_CLAUDE_CREDENTIALS" "$kRescueHome/.claude/.credentials.json"
    chmod 600 "$kRescueHome/.claude/.credentials.json"
    echo '{"hasCompletedOnboarding": true}' > "$kRescueHome/.claude.json"
  fi
else
  kRescueSkipReason="CC_SMOKE_RESCUE is not 1"
fi

ALPHACLAW_ROOT_DIR="$kScratch" SETUP_PASSWORD="$kPass" PORT="$kPort" \
  OPENCLAW_GATEWAY_TOKEN=cc-smoke-token \
  node "$kRepoRoot/bin/alphaclaw.js" start > "$kScratch/server.log" 2>&1 &
kServerPid=$!

for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$kPort/login.html" || true)
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || { echo "FAIL: server never came up"; tail -20 "$kScratch/server.log"; exit 1; }

fail() { echo "FAIL: $1"; "$B" screenshot /tmp/cc-smoke-failure.png >/dev/null 2>&1 || true; exit 1; }
assert_page() { # assert_page <js-bool-expr> <label>
  result=$("$B" js "$1" 2>&1 | tail -1)
  [ "$result" = "true" ] || fail "$2 (js returned: $result)"
  echo "  ok: $2"
}
# Poll a js bool expression until true or N seconds elapse.
wait_page() { # wait_page <js-bool-expr> <seconds> <label>
  for _ in $(seq 1 "$2"); do
    result=$("$B" js "$1" 2>&1 | tail -1)
    [ "$result" = "true" ] && { echo "  ok: $3"; return 0; }
    sleep 1
  done
  fail "$3 (timed out; last js result: ${result:-none})"
}

kItemExpr="[...document.querySelectorAll('.sidebar-nav a')].find(a => a.textContent.includes('Open Claude Code'))"

echo "== login =="
"$B" goto "http://127.0.0.1:$kPort/" >/dev/null
# The login page carries both #password and #password-confirm (create vs
# login states) — target the login field by id.
"$B" wait '#password' >/dev/null
"$B" fill '#password' "$kPass" >/dev/null
"$B" js "document.querySelector('button[type=submit], button')?.click(); true" >/dev/null
sleep 2

echo "== phase 1: unconfigured =="
wait_page "!!($kItemExpr)" 10 "sidebar item renders"
assert_page "($kItemExpr).getAttribute('href') === 'https://claude.ai/code'" "href is the claude.ai/code fallback"
assert_page "!document.querySelector('.sidebar-claude-live-dot')" "no live-dot while unconfigured"

"$B" js "fetch('/api/claude-code/status').then(r=>r.json()).then(d=>{window.__ccStatus=d}); true" >/dev/null
wait_page "window.__ccStatus?.availability?.reason === 'not_configured'" 5 "status reports not_configured through real auth"

"$B" js "fetch('/api/claude-code/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{\"confirmed\":false}'}).then(r=>Promise.all([r.status,r.json()])).then(([s,d])=>{window.__ccFire=[s,d]}); true" >/dev/null
wait_page "window.__ccFire?.[0] === 409 && window.__ccFire?.[1]?.error === 'not_configured'" 5 "unconfigured fire refused with 409 not_configured"

echo "== phase 2: live env reload (no restart) =="
{
  echo "CLAUDE_CODE_ROUTINE_URL=trig_00LIVEUISMOKE0000000"
  echo "CLAUDE_CODE_ROUTINE_TOKEN=sk-ant-oat01-cc-ui-smoke-fake"
} >> "$kScratch/.env"
wait_page "(fetch('/api/claude-code/status').then(r=>r.json()).then(d=>{window.__ccStatus=d}), window.__ccStatus?.availability?.available === true)" 20 "status flips to available via the .env watcher"

echo "== phase 3: configured UI — live-dot, tooltip, confirm modal =="
"$B" goto "http://127.0.0.1:$kPort/" >/dev/null
sleep 2
wait_page "!!document.querySelector('.sidebar-claude-live-dot')" 10 "live-dot appears when configured"
assert_page "($kItemExpr).getAttribute('title').includes('Fires your Claude Code routine')" "tooltip names the autonomous fire"

"$B" js "($kItemExpr).click(); true" >/dev/null
wait_page "document.body.textContent.includes('Start a Claude Code session?')" 8 "one-time confirmation modal appears (server confirm_required)"
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Cancel')?.click(); true" >/dev/null
# Poll to convergence — a fixed sleep before a negative assertion false-passes
# on a slow machine if the DOM updates late.
wait_page "!document.body.textContent.includes('Start a Claude Code session?')" 5 "Cancel closes the modal"

echo "== phase 4: Start — real fire attempt fails honestly, consent persists =="
"$B" js "($kItemExpr).click(); true" >/dev/null
wait_page "document.body.textContent.includes('Start a Claude Code session?')" 8 "modal reappears before consent is stored"
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Start session')?.click(); true" >/dev/null
# Fake credentials: the real outbound fire is rejected upstream (401/404) or
# by the network — every branch surfaces one of the fixed error-toast copies.
wait_page "/rejected|not found|refused to fire|api\\.anthropic\\.com|unusable session URL|Timed out/.test(document.body.textContent)" 25 "fire failure surfaces as an honest error toast"
assert_page "Object.keys(localStorage).some(k => String(localStorage.getItem(k)).includes('\"claudeCodeFireConfirmed\":true'))" "consent flag persisted to ui-settings"

"$B" js "($kItemExpr).click(); true" >/dev/null
# Wait for a POSITIVE outcome signal of this click (another fire failure or
# the cooldown refusal toast) before asserting the modal stayed away — a bare
# sleep would false-pass if the modal simply hadn't rendered yet.
wait_page "/rejected|not found|refused to fire|api\\.anthropic\\.com|unusable session URL|Timed out|wait a few seconds/.test(document.body.textContent)" 25 "post-consent click resolves (toast, no modal wait)"
assert_page "!document.body.textContent.includes('Start a Claude Code session?')" "modal never reappears once consented"

echo "== phase 5: local rescue session starts informed (#76 B4, opt-in) =="
if [ "$kRescuePhase" != "run" ]; then
  echo "  skip: $kRescueSkipReason (set CC_SMOKE_RESCUE=1 + CC_SMOKE_CLAUDE_CREDENTIALS to run; bills one short turn)"
else
  # (a) Seed the fixture bundle + the managed CLAUDE.md with the PRODUCTION
  # writer — the same module the incident hook calls — so the smoke pins the
  # file a real incident would leave behind, not a hand-written lookalike.
  # Inputs travel through argv (never a shell string); the quoted heredoc
  # keeps the node source free of shell interpolation.
  node - "$kRescueWorkspace" "$kRescueIncidentId" <<'NODE'
const [workspace, incidentId] = process.argv.slice(2);
const bundle = require(`${process.env.kRepoRootForNode}/lib/server/claude-code-local/incident-bundle`);
const claudeMd = bundle.writeManagedClaudeMd({ dirs: { workspace } });
const written = bundle.writeIncidentBundle({
  incidentId,
  fingerprint: "5a0ce5a0ce5a",
  operatorPrompt: [
    `Watchdog incident ${incidentId} opened on a \`crash\` event (browser smoke fixture).`,
    "Suspected cause: `state_schema_too_new` — read from stderr only; treat it as a hypothesis.",
    "Running OpenClaw 2026.7.1-2 · expected 2026.9.1-beta.1.",
    "",
    "Suggested first steps:",
    "1. Run `alphaclaw diagnose` and compare its verdict with the Boot reports section below.",
    "2. This is a smoke-test fixture: do not change anything on this box.",
  ].join("\n"),
  crash: { cause: "state_schema_too_new", code: 1, signal: null },
  stderrLines: [
    "OpenClaw state database /tmp/qa-root/.openclaw/openclaw.sqlite uses newer schema version 12; this build supports 1.",
    "Refused by 2026.7.1-2.",
  ],
  bootReports: { current: { bootId: "smoke:0", serverPhase: { verdict: ["state_schema_too_new"] } }, previous: [], incident: null },
  diagnoseMarkdown: "# AlphaClaw diagnose\n\n(browser smoke fixture)\n",
  dirs: { workspace },
});
if (!claudeMd.ok || !written.ok) {
  console.error(JSON.stringify({ claudeMd, written }));
  process.exit(1);
}
console.log(`  seeded ${written.path} (${written.bytes} bytes) + ${claudeMd.path}`);
NODE
  [ -f "$kRescueWorkspace/$kRescueBundleName" ] || fail "fixture bundle was not written"
  head -1 "$kRescueWorkspace/CLAUDE.md" | grep -q "alphaclaw-managed-claude-md" || fail "managed CLAUDE.md marker missing"

  # (b) Spawn the real local session through the real route (humans-only,
  # consent named) and wait for the service to report it running: the pane is
  # a real `claude remote-control` in the managed workspace, pre-trusted by
  # ensureWorkspaceTrust — the rc-workspace-not-trusted.txt exit would surface
  # here as an error state instead of `running`.
  "$B" js "fetch('/api/claude-code/local/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirmed:true,permissionMode:'acceptEdits'})}).then(r=>Promise.all([r.status,r.json()])).then(([s,d])=>{window.__ccLocal=[s,d]}); true" >/dev/null
  wait_page "window.__ccLocal?.[0] === 202 || window.__ccLocal?.[0] === 200" 15 "local session start accepted through the real route"
  wait_page "(fetch('/api/claude-code/status').then(r=>r.json()).then(d=>{window.__ccLocalStatus=d.local}), window.__ccLocalStatus?.state === 'running')" 90 "local rescue session reaches running (URL extracted)"
  assert_page "window.__ccLocalStatus?.cwd === '$kRescueWorkspace'" "session cwd is the managed workspace (never an operator dir)"
  [ -f "$kRescueWorkspace/$kRescueBundleName" ] || fail "bundle vanished after the spawn"

  # (c) The acknowledgement, fixture-pinned: a one-shot print-mode run in the
  # SAME workspace and HOME (trust already seeded for it by the spawn) must
  # name the pinned bundle file — the only way a fresh session can know it is
  # through the managed CLAUDE.md. `-p` is used on a plain `claude` invocation
  # (well-known print mode), never on `remote-control`. Bills one short turn.
  ack=$(cd "$kRescueWorkspace" && HOME="$kRescueHome" timeout 180 env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN \
    claude -p "Answer with the exact filename (nothing else) of the incident bundle your CLAUDE.md tells you to read first in this workspace." \
    --output-format text 2>"$kScratch/claude-p.err" || true)
  echo "  claude -p said: $(printf '%s' "$ack" | head -c 200 | tr '\n' ' ')"
  printf '%s' "$ack" | grep -q "$kRescueBundleName" || {
    echo "--- claude -p stderr ---"; tail -20 "$kScratch/claude-p.err"
    fail "spawned session did not acknowledge $kRescueBundleName through the managed CLAUDE.md"
  }
  echo "  ok: session acknowledges $kRescueBundleName"

  # (d) Leave nothing running: stop through the route (kills the tmux session).
  "$B" js "fetch('/api/claude-code/local/session/stop',{method:'POST'}).then(r=>{window.__ccLocalStop=r.status}); true" >/dev/null
  wait_page "window.__ccLocalStop === 200" 15 "local session stopped"
fi

echo "PASS: claude-code launcher browser smoke"
