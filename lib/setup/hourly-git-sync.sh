#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# Load persisted env vars when running under cron's minimal environment.
# Parsed line-by-line, NEVER sourced (issue #26): under `set -e`, sourcing a
# value with spaces (NODE_OPTIONS=--max-old-space-size=8192 --heapsnapshot-…)
# made bash execute the trailing tokens and abort the entire sync with one
# unread log line — and $(…) in any value executed as root. Only an allowlist
# is exported: startup-sensitive vars (NODE_OPTIONS, LD_PRELOAD, GIT_*)
# exported here would take effect when this script launches node/git — BEFORE
# alphaclaw's JS dotenv loader runs — turning an .env write into root code
# execution. The `alphaclaw git-sync` child re-loads the full .env itself, so
# nothing functional is lost. Values keep spaces; one layer of matching
# surrounding quotes is stripped; nothing is ever expanded or executed.
# NOTE: keep in sync with the twin parser in lib/scripts/git (git shim).
if [[ -f "$REPO/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    if [[ "$key" == "$line" ]]; then continue; fi
    if [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then continue; fi
    case "$key" in
      ALPHACLAW_GIT_LOCK_FD|ALPHACLAW_GIT_LOCK_HELD) continue ;;
      GITHUB_TOKEN|GITHUB_WORKSPACE_REPO|ALPHACLAW_*|OPENCLAW_*) ;;
      *) continue ;;
    esac
    if [[ ${#val} -ge 2 && "$val" == \"*\" && "$val" == *\" ]]; then
      val="${val:1:${#val}-2}"
    elif [[ ${#val} -ge 2 && "$val" == \'*\' && "$val" == *\' ]]; then
      val="${val:1:${#val}-2}"
    fi
    export "$key=$val"
  done < "$REPO/.env"
fi

if [[ -f "$REPO/cron/system-sync.json" ]]; then
  if node - "$REPO/cron/system-sync.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
try {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  process.exit(config && config.enabled === false ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
  then
    echo "hourly-git-sync: disabled by cron/system-sync.json"
    exit 0
  fi
fi

resolve_alphaclaw_cmd() {
  if command -v alphaclaw >/dev/null 2>&1; then
    command -v alphaclaw
    return 0
  fi

  local candidate_paths=(
    "/app/node_modules/.bin/alphaclaw"
    "$REPO/node_modules/.bin/alphaclaw"
    "$REPO/../node_modules/.bin/alphaclaw"
  )
  local candidate
  for candidate in "${candidate_paths[@]}"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

msg="Auto-commit hourly sync $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
alphaclaw_cmd="$(resolve_alphaclaw_cmd || true)"
if [[ -z "${alphaclaw_cmd:-}" ]]; then
  echo "hourly-git-sync: alphaclaw CLI not found in PATH or known install paths" >&2
  exit 127
fi
# The CLI takes alphaclaw-writer.lock itself and never rewrites the working
# tree (issue #140); this script must not run git commands of its own.
"$alphaclaw_cmd" git-sync --trigger scheduled -m "$msg"
