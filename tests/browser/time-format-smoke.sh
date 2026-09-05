#!/bin/bash
# Browser-level E2E for UI time normalization — a REAL server driven by a REAL
# headless Chromium, asserting rendered timestamps against expectations that
# the BROWSER ITSELF computes with the same Intl presets. This proves the full
# pipeline (server ISO/epoch → API → client formatter → DOM) in whatever
# locale/timezone the browser runs, without pinning locale-specific strings.
#
# Opt-in like tests/live/**: needs the gstack browse CLI (or set BROWSE_BIN)
# and Node from AlphaClaw's supported matrix (set NODE_BIN to override).
#
#   BROWSE_BIN=~/.claude/skills/gstack/browse/dist/browse tests/browser/time-format-smoke.sh
#
# browse `js` eval quirks (learned the hard way): NO optional chaining (?.),
# and inside `await` chains use EXPRESSION-BODIED arrow callbacks only (braced
# arrow bodies and `function` callbacks make the eval return empty).
#
# Covers the normalization contract end-to-end:
#   1. Gateway card "Last health check" equals Intl(medium/short) of the API ISO
#   2. Watchdog console lines carry local `YYYY-MM-DD HH:mm:ss ±HH:MM` prefixes
#      (no raw `...Z` ISO at line starts), the zone caption names the browser's
#      zone, and the copy action reads "Copy diagnostics (UTC)"
#   3. Incident timeline shows SECONDS (sub-minute causality) and tooltips are
#      dual-register: "‹local w/ offset› · ‹raw UTC ISO›"
set -euo pipefail

kPort="${UI_TIME_SMOKE_PORT:-3797}"
kPass="time-smoke-pass"
B="${BROWSE_BIN:-$HOME/.claude/skills/gstack/browse/dist/browse}"
kNode="${NODE_BIN:-node}"
kRepoRoot="$(cd "$(dirname "$0")/../.." && pwd)"

if [ ! -x "$B" ]; then
  echo "SKIP: browse CLI not found at $B (set BROWSE_BIN)" >&2
  exit 0
fi

kScratch="$(mktemp -d /tmp/alphaclaw-time-smoke-XXXXXX)"
cleanup() {
  # Never `kill 0` (fix wave F181): with no server pid recorded the old
  # `${kServerPid:-0}` fallback killed the caller's whole process group.
  if [ -n "${kServerPid:-}" ] && [ "${kServerPid}" != "0" ]; then
    kill "${kServerPid}" 2>/dev/null || true
  fi
  sleep 1 # let the server finish in-flight cache writes before the scratch dir goes
  rm -rf "$kScratch" 2>/dev/null || true
}
trap cleanup EXIT

# Minimal onboarded fixture. The gateway binary is absent on purpose: the
# failed spawn degrades the watchdog, which opens a real incident with a real
# event timeline — exactly the data the time assertions need.
mkdir -p "$kScratch/.openclaw"
echo '{"onboardedAt": 0, "source": "time-smoke"}' > "$kScratch/onboarded.json"
echo '{"gateway": {"mode": "local", "port": 18996, "auth": {"token": "${OPENCLAW_GATEWAY_TOKEN}"}}}' \
  > "$kScratch/.openclaw/openclaw.json"
echo "SETUP_PASSWORD=$kPass" > "$kScratch/.env"

ALPHACLAW_ROOT_DIR="$kScratch" SETUP_PASSWORD="$kPass" PORT="$kPort" \
  OPENCLAW_GATEWAY_TOKEN=time-smoke-token \
  "$kNode" "$kRepoRoot/bin/alphaclaw.js" start > "$kScratch/server.log" 2>&1 &
kServerPid=$!

code=""
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$kPort/login.html" || true)
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || { echo "FAIL: server never came up"; tail -20 "$kScratch/server.log"; exit 1; }

fail() { echo "FAIL: $1"; "$B" screenshot /tmp/time-smoke-failure.png >/dev/null 2>&1 || true; exit 1; }
assert_page() { # assert_page <js-bool-expr> <label>
  result=$("$B" js "$1" 2>&1 | tail -1)
  [ "$result" = "true" ] || fail "$2 (js returned: $result)"
  echo "  ok: $2"
}

echo "== login =="
"$B" goto "http://127.0.0.1:$kPort/login.html" >/dev/null
# Log in through the API from inside the page. Two hazards this sidesteps:
# (1) the shared browse daemon's cookies are per-HOST, so a stale session from
# another 127.0.0.1 port can mask an unauthenticated API session; (2) a fresh
# boot can spend its first minute in an "AlphaClaw is updating" phase that
# rejects logins — poll until the login is genuinely accepted.
ok=""
for i in $(seq 1 36); do
  ok=$("$B" js "await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'$kPass'})}).then(r=>r.json()).then(j=>j.ok===true).catch(()=>false)" 2>&1 | tail -1)
  [ "$ok" = "true" ] && break
  sleep 5
done
[ "$ok" = "true" ] || fail "login API never accepted (still in the updating phase?)"
"$B" goto "http://127.0.0.1:$kPort/" >/dev/null
sleep 2
assert_page "location.pathname === '/' && document.body.textContent.indexOf('OpenClaw Gateway') >= 0" "logged in, app shell rendered"

echo "== gateway card: Last health check equals Intl(medium/short) of the API ISO =="
# Wait for the first watchdog probe (can take ~2-3 min on a fresh boot with a
# dead gateway), then compare atomically in one evaluation so the value can't
# move between fetch and DOM read.
ready=""
for i in $(seq 1 42); do
  ready=$("$B" js "await fetch('/api/watchdog/status').then(r=>r.json()).then(s=>!!(s.status && s.status.lastHealthCheckAt)).catch(()=>false)" 2>&1 | tail -1)
  [ "$ready" = "true" ] && break
  sleep 5
done
[ "$ready" = "true" ] || fail "watchdog never produced lastHealthCheckAt"
# The gateway card's disclosure is a BUTTON labeled "Details", not a <details>.
"$B" js "var b=Array.from(document.querySelectorAll('button')).find(x=>x.textContent.indexOf('Details')>=0); b && b.click(); true" >/dev/null
sleep 2
# The DOM refreshes on a ~2s poll while probes land ~30s apart, so DOM and API
# can disagree for a beat across a probe boundary — retry the atomic compare.
match=""
for i in 1 2 3; do
  match=$("$B" js "await fetch('/api/watchdog/status').then(r=>r.json()).then(s=>document.body.textContent.indexOf(new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(new Date(s.status.lastHealthCheckAt)))>=0)" 2>&1 | tail -1)
  [ "$match" = "true" ] && break
  sleep 3
done
[ "$match" = "true" ] || fail "Last health check renders the Intl medium/short value (js returned: $match)"
echo "  ok: Last health check renders the Intl medium/short value"

echo "== watchdog console: local prefixes, zone caption, UTC copy label =="
"$B" goto "http://127.0.0.1:$kPort/#/watchdog" >/dev/null
sleep 3
# Multiline anchors ('m' flag): a regression on lines 2..N must fail the
# smoke, not hide behind a clean first line.
assert_page "(((document.querySelector('pre.watchdog-logs-panel')||{}).textContent||'').match(new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} [+-][0-9]{2}:[0-9]{2} ','gm'))||[]).length >= 2" \
  "multiple console lines start with local YYYY-MM-DD HH:mm:ss ±HH:MM"
assert_page "((document.querySelector('pre.watchdog-logs-panel')||{}).textContent||'x').length > 1 && !new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}T','m').test(((document.querySelector('pre.watchdog-logs-panel')||{}).textContent||''))" \
  "no raw ISO 'T' timestamps at any line start"
assert_page "document.body.textContent.indexOf('Line timestamps shown in ' + Intl.DateTimeFormat().resolvedOptions().timeZone) >= 0" \
  "caption names the browser's actual zone"
assert_page "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.indexOf('Copy diagnostics (UTC)')>=0)" \
  "copy action is labeled 'Copy diagnostics (UTC)'"

echo "== incident timeline: seconds visible + dual-register tooltips =="
# The failed gateway spawn opens incident #1 within the watchdog's first probe
# window. Poll the API, then expand the incident card in the DOM.
opened=""
for i in $(seq 1 24); do
  opened=$("$B" js "await fetch('/api/watchdog/incidents').then(r=>r.json()).then(s=>((s.incidents||s.items)||[]).length>0).catch(()=>false)" 2>&1 | tail -1)
  [ "$opened" = "true" ] && break
  sleep 5
done
[ "$opened" = "true" ] || fail "no incident opened within the poll window"
"$B" goto "http://127.0.0.1:$kPort/#/watchdog" >/dev/null
sleep 3
# The incidents section loads async and the card must be expanded before its
# timeline (and titles) exist — retry expand+check until the tooltips appear.
titled=""
for i in 1 2 3 4 5 6; do
  "$B" js "var el=Array.from(document.querySelectorAll('button,summary,[role=button]')).find(b=>b.textContent.indexOf('Gateway')>=0 && (b.textContent.indexOf('Ongoing')>=0 || b.textContent.indexOf('events')>=0)); el && el.click(); true" >/dev/null
  sleep 3
  titled=$("$B" js "Array.from(document.querySelectorAll('[title]')).some(n=>!!n.getAttribute('title') && new RegExp('GMT[+-]?[0-9].* · [0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$').test(n.getAttribute('title')))" 2>&1 | tail -1)
  [ "$titled" = "true" ] && break
done
[ "$titled" = "true" ] || fail "tooltips are dual-register: local+offset · raw UTC ISO (js returned: $titled)"
echo "  ok: tooltips are dual-register: local+offset · raw UTC ISO"
assert_page "new RegExp(':[0-9]{2}:[0-9]{2}').test(document.body.textContent)" \
  "timeline shows seconds-level precision"

echo "PASS: time format smoke"
