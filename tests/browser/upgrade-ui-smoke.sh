#!/bin/bash
# Browser-level UI smoke for the Upgrade page — a REAL server driven by a REAL
# headless Chromium, asserting the rendered DOM (not component shims).
#
# Opt-in like tests/live/**: needs the gstack browse CLI (or set BROWSE_BIN),
# network for the version catalog, and Node from AlphaClaw's supported matrix
# (>=22.22.3 <23, >=24.15 <25, >=25.9).
#
#   BROWSE_BIN=~/.claude/skills/gstack/browse/dist/browse tests/browser/upgrade-ui-smoke.sh
#
# Covers the exact regression that motivated the Upgrade UX overhaul: clicking
# a channel segment must persist immediately and raise the mismatch banner —
# never silently snap back.
set -euo pipefail

kPort="${UI_SMOKE_PORT:-3799}"
kPass="ui-smoke-pass"
B="${BROWSE_BIN:-$HOME/.claude/skills/gstack/browse/dist/browse}"
kRepoRoot="$(cd "$(dirname "$0")/../.." && pwd)"

if [ ! -x "$B" ]; then
  echo "SKIP: browse CLI not found at $B (set BROWSE_BIN)" >&2
  exit 0
fi

kScratch="$(mktemp -d /tmp/alphaclaw-ui-smoke-XXXXXX)"
cleanup() {
  pkill -f "alphaclaw.js start.*$kScratch" 2>/dev/null || true
  pkill -f "ALPHACLAW_UI_SMOKE=$kScratch" 2>/dev/null || true
  # Never `kill 0` (fix wave F181): with no server pid recorded the old
  # `${kServerPid:-0}` fallback killed the caller's whole process group.
  if [ -n "${kServerPid:-}" ] && [ "${kServerPid}" != "0" ]; then
    kill "${kServerPid}" 2>/dev/null || true
  fi
  rm -rf "$kScratch"
}
trap cleanup EXIT

# Minimal onboarded fixture: dashboard (and the Upgrade page) needs the marker.
mkdir -p "$kScratch/.openclaw"
echo '{"onboardedAt": 0, "source": "ui-smoke"}' > "$kScratch/onboarded.json"
echo '{"gateway": {"mode": "local", "port": 18998, "auth": {"token": "${OPENCLAW_GATEWAY_TOKEN}"}}}' \
  > "$kScratch/.openclaw/openclaw.json"
echo "SETUP_PASSWORD=$kPass" > "$kScratch/.env"

ALPHACLAW_UI_SMOKE="$kScratch" ALPHACLAW_ROOT_DIR="$kScratch" \
  SETUP_PASSWORD="$kPass" PORT="$kPort" OPENCLAW_GATEWAY_TOKEN=ui-smoke-token \
  node "$kRepoRoot/bin/alphaclaw.js" start > "$kScratch/server.log" 2>&1 &
kServerPid=$!

for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$kPort/login.html" || true)
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || { echo "FAIL: server never came up"; tail -20 "$kScratch/server.log"; exit 1; }

fail() { echo "FAIL: $1"; "$B" screenshot /tmp/ui-smoke-failure.png >/dev/null 2>&1 || true; exit 1; }
assert_page() { # assert_page <js-bool-expr> <label>
  result=$("$B" js "$1" 2>&1 | tail -1)
  [ "$result" = "true" ] || fail "$2 (js returned: $result)"
  echo "  ok: $2"
}

echo "== login =="
"$B" goto "http://127.0.0.1:$kPort/" >/dev/null
"$B" wait 'input#password' >/dev/null
"$B" fill 'input#password' "$kPass" >/dev/null
"$B" js "document.querySelector('button[type=submit], button')?.click(); true" >/dev/null
sleep 2

echo "== upgrade page renders =="
"$B" goto "http://127.0.0.1:$kPort/#/upgrade" >/dev/null
sleep 3
assert_page "document.body.textContent.includes('Versions & Channels')" "page title present"
assert_page "document.body.textContent.includes('Release channel')" "status card present"
assert_page "document.body.textContent.includes('Overseer report')" "overseer card present"

echo "== channel switch persists immediately + mismatch banner =="
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Beta')?.click(); true" >/dev/null
sleep 3
assert_page "document.body.textContent.includes('Channel set to beta')" "mismatch banner appeared"
grep -q '"releaseChannel": "beta"' "$kScratch/.openclaw/alphaclaw.json" \
  || fail "channel not persisted to alphaclaw.json"
echo "  ok: channel persisted on disk"

echo "== persistence survives reload =="
"$B" goto "http://127.0.0.1:$kPort/#/upgrade" >/dev/null
sleep 3
assert_page "document.body.textContent.includes('Channel set to beta')" "banner survives reload"

echo "== back to stable clears the banner =="
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Back to stable')?.click(); true" >/dev/null
sleep 3
assert_page "!document.body.textContent.includes('Channel set to beta')" "banner cleared"
grep -q '"releaseChannel": "stable"' "$kScratch/.openclaw/alphaclaw.json" \
  || fail "channel not restored to stable"
echo "  ok: restored to stable"

echo "== overseer toggle flips instantly and never snaps back =="
# The founding regression of the toggle overhaul: a pessimistic handler let
# Preact re-assert checked=false on the saving re-render, so the switch
# visibly snapped back and looked dead. Only a real DOM catches that.
overseer_input="[...document.querySelectorAll('.bg-surface')].find(c => c.textContent.includes('Overseer report'))?.querySelector('.ac-toggle-input')"
assert_page "($overseer_input)?.checked === false" "overseer toggle starts disabled"
# Click and read in ONE evaluation: separate CLI invocations are ~100ms+
# apart, long enough for the localhost PUT to settle and mask a snap-back.
# The synchronous read catches an immediate re-assertion; the optimistic
# render frame itself is pinned by the unit harness (Preact re-renders are
# async, so no DOM read here can be scheduled between click and re-render).
assert_page "(i => { i?.closest('label')?.click(); return i?.checked === true; })($overseer_input)" "overseer toggle flipped instantly (no snap-back)"
sleep 2
assert_page "($overseer_input)?.checked === true" "overseer toggle stayed on after the save settled"
node -e "const c=require('$kScratch/.openclaw/alphaclaw.json'); process.exit(c.updates?.openclaw?.overseer?.enabled===true?0:1)" \
  || fail "overseer enabled not persisted to alphaclaw.json"
echo "  ok: overseer enabled persisted on disk"

echo "== overseer toggle state survives reload =="
"$B" goto "http://127.0.0.1:$kPort/#/upgrade" >/dev/null
sleep 3
assert_page "($overseer_input)?.checked === true" "overseer toggle still on after reload"
"$B" js "($overseer_input)?.closest('label')?.click(); true" >/dev/null
sleep 2
assert_page "($overseer_input)?.checked === false" "overseer toggle disabled again"

echo "== #54 QA: Backups card renders its honest empty state =="
assert_page "document.body.textContent.includes('Backups') && document.body.textContent.includes('No backups yet — the next OpenClaw update takes one before installing')" "Backups card empty state (a pre-update backup runs on every apply)"
"$B" screenshot /tmp/ui-smoke-qa-backups-card.png >/dev/null 2>&1 || true

echo "== #54 QA: hard-gated confirm shows the reuse consent — unchecked, disabled, with its reason — and cancels without applying =="
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Beta')?.click(); true" >/dev/null
sleep 3
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Update to '))?.click(); true" >/dev/null
sleep 2
assert_page "document.body.textContent.includes(\"If a fresh backup can't be made, proceed with the most recent verified backup\")" "consent toggle present in the cross-channel confirm"
assert_page "document.body.textContent.includes('No eligible backup to reuse')" "consent disabled reason: no eligible backup"
consent_input="[...document.querySelectorAll('label')].find(l => l.textContent.includes('most recent verified backup'))?.querySelector('input')"
assert_page "(i => !!i && i.checked === false && i.disabled === true)($consent_input)" "consent toggle is unchecked and disabled (never pre-checked)"
"$B" screenshot /tmp/ui-smoke-qa-consent-dialog.png >/dev/null 2>&1 || true
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Cancel')?.click(); true" >/dev/null
sleep 1
assert_page "!document.body.textContent.includes(\"If a fresh backup can't be made\")" "confirm dismissed"
grep -q '"lastUpdateRun"' "$kScratch/.openclaw/.alphaclaw/openclaw-channel.json" 2>/dev/null && fail "cancelling the confirm must not start an apply"
echo "  ok: no apply started"
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Back to stable')?.click(); true" >/dev/null
sleep 3
grep -q '"releaseChannel": "stable"' "$kScratch/.openclaw/alphaclaw.json" || fail "channel not restored to stable after the consent check"
echo "  ok: restored to stable"

echo "== #54 QA: Watchdog test notification reports honestly (nothing configured → the server's 502 renders inline, never a false success) =="
"$B" goto "http://127.0.0.1:$kPort/#/watchdog" >/dev/null
sleep 3
test_button="[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Test' && b.getAttribute('aria-hidden') !== 'true')"
visible=$("$B" js "!!($test_button)" 2>&1 | tail -1)
if [ "$visible" = "true" ]; then
  "$B" js "($test_button)?.click(); true" >/dev/null
  sleep 3
  assert_page "document.body.textContent.includes('nothing is configured or paired')" "test notification: honest 'nothing is configured or paired'"
  assert_page "!document.body.textContent.includes('Test notification sent')" "test notification: no false success"
  "$B" screenshot /tmp/ui-smoke-qa-test-notification.png >/dev/null 2>&1 || true
else
  echo "  skipped: notifications are disabled in this fixture (Test button hidden)"
fi

echo "PASS: upgrade UI smoke"
