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

# Drop cron scheduler runtime-only churn when it is metadata/timestamp-only.
maybe_restore_if_runtime_only() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  # Only inspect when the file differs from HEAD.
  if git diff --quiet -- "$file"; then
    return 0
  fi

  if node - "$file" <<'NODE'
const fs = require('fs');
const cp = require('child_process');
const file = process.argv[2];

const sanitize = (value) => {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(lastRun|nextRun|updatedAt|createdAt|lastStarted|lastFinished|lastSuccess|lastFailure|lastError|lastExitCode|lastDurationMs|runCount|runs|timestamp|time|ts|ms)$/i.test(k)) {
        continue;
      }
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
};

const parseJson = (str) => {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
};

let headRaw = '';
try {
  headRaw = cp.execSync(`git show HEAD:${file}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch {
  process.exit(2); // no HEAD version to compare
}

let workRaw = '';
try {
  workRaw = fs.readFileSync(file, 'utf8');
} catch {
  process.exit(3);
}

const headJson = parseJson(headRaw);
const workJson = parseJson(workRaw);
if (!headJson || !workJson) process.exit(4);

const a = JSON.stringify(sanitize(headJson));
const b = JSON.stringify(sanitize(workJson));
process.exit(a === b ? 0 : 1);
NODE
  then
    # Runtime metadata only; restore cleanly so it doesn't create noise commits.
    git restore --worktree --staged -- "$file" || git checkout -- "$file"
  fi
}

maybe_restore_if_runtime_only "cron/jobs.json"
maybe_restore_if_runtime_only "crons.json"

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
"$alphaclaw_cmd" git-sync -m "$msg"
