#!/usr/bin/env bash
# A generic operator box lock, the shape AlphaClaw's box lock honors
# (lib/server/box-lock.js): one flock(1) lock file, an owner record beside it
# and an append-only log. Used by the hermetic tests and the VM proof.
#
#   BOX_LOCK=/srv/ops/box.lock box-lock.sh run <owner> <step> [--wait sec] -- <cmd...>
#   BOX_LOCK=/srv/ops/box.lock box-lock.sh status
#
# run: exits 75 (EX_TEMPFAIL) and prints "box_lock_busy: <owner json>" while
# someone else holds the lock; otherwise runs the command with the lock fd
# closed, so nothing it starts keeps the lock. status: exit 0 free, 1 held.
set -uo pipefail
L="${BOX_LOCK:?set BOX_LOCK to the lock file path}"
base="${L%.lock}"
O="${base}.owner"
LOG="${base}.log"
now() { date -u +%FT%TZ; }
san() { printf '%s' "$1" | tr -c 'A-Za-z0-9._:@/+-' '_' | cut -c1-80; }
cmd="${1:-}"
shift || true
case "$cmd" in
  status)
    exec 9>>"$L"
    if flock -n 9; then
      echo "free (last: $(cat "$O" 2>/dev/null))"
      exit 0
    fi
    echo "held: $(cat "$O" 2>/dev/null)"
    exit 1
    ;;
  run)
    owner=$(san "$1")
    step=$(san "$2")
    shift 2
    wait=0
    if [[ "${1:-}" == "--wait" ]]; then
      wait="$2"
      shift 2
    fi
    [[ "${1:-}" == "--" ]] && shift
    by=$(san "${BOX_LOCK_BY:-operator}")
    exec 9>>"$L"
    if ! flock -x -w "$wait" 9; then
      echo "box_lock_busy: $(cat "$O" 2>/dev/null)"
      exit 75
    fi
    printf '{"owner":"%s","step":"%s","started_at":"%s","pid":%d,"host":"%s","by":"%s"}\n' \
      "$owner" "$step" "$(now)" $$ "${HOSTNAME:-$(uname -n)}" "$by" > "$O.tmp" && mv "$O.tmp" "$O"
    echo "$(now) acquire $owner $step pid=$$ by=$by" >> "$LOG"
    "$@" 9>&-
    rc=$?
    printf '{"owner":"%s","step":"%s","finished_at":"%s","rc":%d,"by":"%s"}\n' \
      "$owner" "$step" "$(now)" "$rc" "$by" > "$O.tmp" && mv "$O.tmp" "$O"
    echo "$(now) release $owner $step rc=$rc by=$by" >> "$LOG"
    exit "$rc"
    ;;
  *)
    echo "usage: box-lock.sh run <owner> <step> [--wait sec] -- <cmd...> | status" >&2
    exit 2
    ;;
esac
