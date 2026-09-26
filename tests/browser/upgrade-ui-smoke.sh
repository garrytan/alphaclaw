#!/bin/bash
# Browser-level UI smoke for the Upgrade page — a REAL server driven by a REAL
# headless Chromium, asserting the rendered DOM (not component shims).
#
# Opt-in like tests/live/**: needs the gstack browse CLI (or set BROWSE_BIN),
# network for the version catalog, and Node from AlphaClaw's supported matrix
# (>=24.16.0 <25 || >=26.1.0 since v0.9.80 — the OpenClaw 2026.9.3 pin).
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
kArtifacts="${UI_SMOKE_ARTIFACTS:-$kRepoRoot/.context/wave-browser/existing-smoke}"
mkdir -p "$kArtifacts"

if [ ! -x "$B" ]; then
  echo "SKIP: browse CLI not found at $B (set BROWSE_BIN)" >&2
  exit 0
fi

kScratch="$(mktemp -d /tmp/alphaclaw-ui-smoke-XXXXXX)"
cleanup() {
  if [ "${kBrowserOpened:-}" = "1" ]; then "$B" closetab >/dev/null 2>&1 || true; fi
  [ ! -f "$kScratch/server.log" ] || cp "$kScratch/server.log" "$kArtifacts/server.log"
  pkill -f "alphaclaw.js start.*$kScratch" 2>/dev/null || true
  pkill -f "ALPHACLAW_UI_SMOKE=$kScratch" 2>/dev/null || true
  # Never `kill 0` (fix wave F181): with no server pid recorded the old
  # `${kServerPid:-0}` fallback killed the caller's whole process group.
  if [ -n "${kServerPid:-}" ] && [ "${kServerPid}" != "0" ]; then
    kill "${kServerPid}" 2>/dev/null || true
    # Let the owned server finish reaping its gateway before deleting the
    # fixture; otherwise shutdown can recreate files during rm's traversal.
    wait "${kServerPid}" 2>/dev/null || true
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

fail() { echo "FAIL: $1"; "$B" screenshot "$kArtifacts/failure.png" >/dev/null 2>&1 || true; "$B" console --errors > "$kArtifacts/console-errors.txt" 2>&1 || true; exit 1; }
assert_page() { # assert_page <js-bool-expr> <label>
  result=$("$B" js "$1" 2>&1 | tail -1)
  [ "$result" = "true" ] || fail "$2 (js returned: $result)"
  echo "  ok: $2"
}

echo "== login =="
"$B" newtab "http://127.0.0.1:$kPort/" >/dev/null
kBrowserOpened=1
"$B" viewport 1280x720 >/dev/null
"$B" console --clear >/dev/null
"$B" wait 'input#password, .app-shell' >/dev/null || fail "login or dashboard did not become ready"
if [ "$("$B" js "!!document.querySelector('input#password')" 2>&1 | tail -1)" = "true" ]; then
  "$B" fill 'input#password' "$kPass" >/dev/null
  "$B" js "document.querySelector('button[type=submit], button')?.click(); true" >/dev/null
fi
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
assert_page "[...document.querySelectorAll('.ac-segmented-control-button.active')].some(b => b.textContent.trim()==='Beta') && document.body.textContent.includes('Back to stable')" "beta selection and return-to-stable banner appeared"
grep -q '"releaseChannel": "beta"' "$kScratch/.openclaw/alphaclaw.json" \
  || fail "channel not persisted to alphaclaw.json"
echo "  ok: channel persisted on disk"

echo "== persistence survives reload =="
"$B" goto "http://127.0.0.1:$kPort/#/upgrade" >/dev/null
sleep 3
assert_page "[...document.querySelectorAll('.ac-segmented-control-button.active')].some(b => b.textContent.trim()==='Beta') && document.body.textContent.includes('Back to stable')" "beta selection and banner survive reload"

echo "== back to stable clears the banner =="
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Back to stable')?.click(); true" >/dev/null
sleep 3
assert_page "!document.body.textContent.includes('Back to stable')" "banner cleared"
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
assert_page "document.body.textContent.includes('Backups') && document.body.textContent.includes('No recovery artifacts yet — the next OpenClaw update creates a configuration checkpoint')" "Recovery inventory has an honest empty state"
assert_page "document.body.textContent.includes('Configuration checkpoint; database data not backed up') && document.body.textContent.includes('16 MiB')" "Default checkpoint states its coverage and hard cap"
assert_page "![...document.querySelectorAll('button')].some(b => /full backup|exclusions/i.test(b.textContent))" "No full-backup or exclusion controls"
"$B" screenshot "$kArtifacts/backups-card.png" >/dev/null 2>&1 || true

echo "== recovery QA: standalone database snapshot requires size review and cancels without copying =="
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Create database snapshot')?.click(); true" >/dev/null
sleep 2
assert_page "document.querySelector('[role=dialog]')?.textContent.includes('Create database snapshot?')" "Manual database snapshot opens an explicit confirmation"
assert_page "document.querySelector('[role=dialog]')?.textContent.includes('Database snapshot selected:')" "Manual snapshot confirmation shows the database count and size estimate"
assert_page "document.querySelector('[role=dialog]')?.textContent.includes('No upgrade will be installed')" "Standalone snapshot does not imply an upgrade"
"$B" screenshot "$kArtifacts/manual-database-snapshot.png" >/dev/null 2>&1 || true
"$B" js "[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim()==='Cancel')?.click(); true" >/dev/null
assert_page "!document.querySelector('[role=dialog]')" "Manual snapshot cancelled before copying"
assert_page "fetch('/api/openclaw/runs').then(r => r.json()).then(d => !(d.runs || []).some(r => r.target?.kind === 'backup'))" "Cancelling snapshot review did not create a backup run"

echo "== recovery QA: cross-channel confirm names config-only coverage and cancels without applying =="
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Beta')?.click(); true" >/dev/null
sleep 3
# The newest beta can be OLDER than the installed stable. Select its actual
# catalog action so this consent journey tests both release orderings.
"$B" js "[...[...document.querySelectorAll('h3')].find(h => h.textContent.trim()==='Beta')?.parentElement.querySelectorAll('button') || []].find(b => /^(Upgrade|Downgrade|Switch)$/.test(b.textContent.trim()))?.click(); true" >/dev/null
sleep 2
assert_page "!!document.querySelector('[role=dialog]') && document.querySelector('[role=dialog]').textContent.includes('Configuration checkpoint; database data not backed up')" "Cross-channel confirmation states database omission"
assert_page "!document.body.textContent.includes(\"If a fresh backup can't be made\")" "Retired archive-reuse consent is absent"
assert_page "!document.querySelector('[role=dialog] input:checked')" "No recovery risk decision is preselected"
"$B" screenshot "$kArtifacts/consent-dialog.png" >/dev/null 2>&1 || true
"$B" js "[...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Cancel')?.click(); true" >/dev/null
sleep 1
assert_page "!document.querySelector('[role=dialog]')" "confirm dismissed"
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
  "$B" screenshot "$kArtifacts/test-notification.png" >/dev/null 2>&1 || true
else
  echo "  skipped: notifications are disabled in this fixture (Test button hidden)"
fi

echo "PASS: upgrade UI smoke"
"$B" console --errors > "$kArtifacts/console-errors.txt" 2>&1 || true
