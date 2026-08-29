#!/bin/bash
# Browser-level E2E smoke for the sidebar Claude Code launcher — a REAL server
# driven by a REAL headless Chromium, asserting the rendered DOM and the full
# request path (browser → session auth → route → service). Nothing here bills:
# the configured phase uses shape-valid FAKE credentials, so the one real
# outbound fire attempt is rejected by api.anthropic.com (or by the network)
# and lands on the error-toast path — which is exactly the assertion.
#
# Opt-in like tests/live/**: needs the gstack browse CLI (or set BROWSE_BIN)
# and Node from AlphaClaw's supported matrix.
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
set -euo pipefail

kPort="${UI_SMOKE_PORT:-3798}"
kPass="cc-smoke-pass"
B="${BROWSE_BIN:-$HOME/.claude/skills/gstack/browse/dist/browse}"
kRepoRoot="$(cd "$(dirname "$0")/../.." && pwd)"

if [ ! -x "$B" ]; then
  echo "SKIP: browse CLI not found at $B (set BROWSE_BIN)" >&2
  exit 0
fi

kScratch="$(mktemp -d /tmp/alphaclaw-cc-smoke-XXXXXX)"
cleanup() {
  kill "${kServerPid:-0}" 2>/dev/null || true
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

echo "PASS: claude-code launcher browser smoke"
