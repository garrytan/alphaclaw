#!/usr/bin/env bash
# Responsiveness harness for the admin server (downtime remediation verification).
#
# Boots the server against a seeded large workspace, holds an SSE connection,
# polls /health and authenticated /api/status at a fixed cadence, and reports
# latency percentiles plus the server's own event-loop-lag stat. Run it before
# and after a change; the p99 target on the reference instance is <100ms for
# /health and cache-served status reads.
#
# Usage:
#   scripts/dev/responsiveness-harness.sh [duration_seconds] [workspace_files]
# Env:
#   HARNESS_PORT (default 3399)  SETUP_PASSWORD (default harness-pass)
set -euo pipefail

DURATION="${1:-60}"
SEED_FILES="${2:-3000}"
PORT="${HARNESS_PORT:-3399}"
PASSWORD="${SETUP_PASSWORD:-harness-pass}"
ROOT_DIR="$(mktemp -d /tmp/ac-harness-XXXXXX)"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$ROOT_DIR/server.log"

echo "[harness] root=$ROOT_DIR port=$PORT duration=${DURATION}s seed=${SEED_FILES} files"

# Seed a large agent workspace so the doctor fingerprint has real work to do.
WORKSPACE="$ROOT_DIR/root/.openclaw/workspace"
mkdir -p "$WORKSPACE"
for i in $(seq 1 "$SEED_FILES"); do
  d="$WORKSPACE/dir$((i % 50))"
  mkdir -p "$d"
  printf 'seed file %s\nsome content line\n' "$i" > "$d/file$i.md"
done

SETUP_PASSWORD="$PASSWORD" PORT="$PORT" ALPHACLAW_ROOT_DIR="$ROOT_DIR/root" \
  node -e "process.env.ALPHACLAW_ROOT_DIR='$ROOT_DIR/root'; require('$REPO_ROOT/lib/server.js');" \
  > "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill -TERM $SERVER_PID 2>/dev/null || true; sleep 1; kill -9 $SERVER_PID 2>/dev/null || true' EXIT

for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
echo "[harness] server up"

# Authenticated session cookie.
COOKIE_JAR="$ROOT_DIR/cookies.txt"
curl -s -c "$COOKIE_JAR" -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" "http://127.0.0.1:$PORT/api/auth/login" >/dev/null || true

# Hold one SSE connection for the whole run (the hot path under test).
curl -sN -b "$COOKIE_JAR" "http://127.0.0.1:$PORT/api/events/status" > "$ROOT_DIR/sse.out" 2>/dev/null &
SSE_PID=$!

HEALTH_TIMES="$ROOT_DIR/health.times"
STATUS_TIMES="$ROOT_DIR/status.times"
END=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$END" ]; do
  curl -s -o /dev/null -w '%{time_total}\n' "http://127.0.0.1:$PORT/health" >> "$HEALTH_TIMES" || true
  curl -s -o /dev/null -b "$COOKIE_JAR" -w '%{time_total}\n' "http://127.0.0.1:$PORT/api/status" >> "$STATUS_TIMES" || true
  sleep 0.2
done
kill "$SSE_PID" 2>/dev/null || true

pctl() { sort -n "$1" | awk -v p="$2" '{a[NR]=$1} END{idx=int(NR*p/100); if(idx<1)idx=1; printf "%.1fms", a[idx]*1000}'; }
report() {
  local f="$1" name="$2"
  echo "[harness] $name: n=$(wc -l < "$f") p50=$(pctl "$f" 50) p95=$(pctl "$f" 95) p99=$(pctl "$f" 99) max=$(sort -n "$f" | tail -1 | awk '{printf "%.1fms", $1*1000}')"
}
report "$HEALTH_TIMES" "/health"
report "$STATUS_TIMES" "/api/status (authed)"
echo "[harness] server eventLoop stat: $(curl -s -b "$COOKIE_JAR" "http://127.0.0.1:$PORT/api/watchdog/resources" | grep -o '"eventLoop":{[^}]*}' || echo 'n/a')"
SSE_EVENTS=$(grep -c '^event: status' "$ROOT_DIR/sse.out" 2>/dev/null || echo 0)
echo "[harness] SSE status events received: $SSE_EVENTS"
echo "[harness] RSS: $(ps -o rss= -p $SERVER_PID | awk '{printf "%.1fMB", $1/1024}')"
echo "[harness] server log tail:"; tail -3 "$LOG"
