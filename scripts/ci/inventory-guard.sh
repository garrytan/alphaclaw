#!/usr/bin/env bash
# PR test-inventory guard (ci.yml, Node 24 lane). Compares this PR's test
# inventory with the inventory of its exact base commit:
#   1. waits (bounded) for the base commit's push run to publish its
#      `test-inventory-node24` artifact;
#   2. otherwise regenerates it from an isolated checkout of that same commit
#      (never a different main revision);
#   3. runs the base commit's copy of the diff (and builder) when it has one,
#      so a PR can't loosen its own check, with the declarations found in the
#      PR's commit messages.
# INVENTORY_GUARD=report prints and warns; INVENTORY_GUARD=enforce fails.
#
# Env: BASE_SHA, HEAD_SHA, GH_TOKEN, INVENTORY_GUARD; optional
# INVENTORY_BASE_WAIT_SECONDS (default 360).
set -euo pipefail

: "${BASE_SHA:?}" "${HEAD_SHA:?}" "${INVENTORY_GUARD:=report}"
work="${RUNNER_TEMP:-$(mktemp -d)}/inventory-guard"
mkdir -p "$work/base"
head_inventory="test-reports/inventory.json"
[ -s "$head_inventory" ] || { echo "::error::no head inventory at $head_inventory"; exit 1; }

judge="scripts/ci/inventory-diff.mjs"
builder="scripts/ci/test-inventory.mjs"
if git cat-file -e "$BASE_SHA:scripts/ci/inventory-diff.mjs" 2>/dev/null; then
  git show "$BASE_SHA:scripts/ci/inventory-diff.mjs" > "$work/inventory-diff.mjs"
  judge="$work/inventory-diff.mjs"
fi
if git cat-file -e "$BASE_SHA:scripts/ci/test-inventory.mjs" 2>/dev/null; then
  git show "$BASE_SHA:scripts/ci/test-inventory.mjs" > "$work/test-inventory.mjs"
  builder="$work/test-inventory.mjs"
fi

base_inventory="$work/base/inventory.json"
deadline=$(( $(date +%s) + ${INVENTORY_BASE_WAIT_SECONDS:-360} ))
while :; do
  run=$(gh run list --workflow ci.yml --commit "$BASE_SHA" --event push --json databaseId,status --jq '.[0] // empty | "\(.databaseId) \(.status)"' 2>/dev/null || true)
  if [ -n "$run" ]; then
    read -r run_id run_status <<<"$run"
    if [ "$run_status" = completed ]; then
      if gh run download "$run_id" -n test-inventory-node24 -D "$work/base" >/dev/null 2>&1 && [ -s "$base_inventory" ]; then
        echo "base inventory: artifact of run $run_id at $BASE_SHA"
      fi
      break
    fi
  fi
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep 15
done

if [ ! -s "$base_inventory" ]; then
  echo "base inventory: no artifact for $BASE_SHA; regenerating it from an isolated checkout of that commit"
  wt="$work/base-tree"
  git worktree add --detach "$wt" "$BASE_SHA" >/dev/null
  (cd "$wt" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx vitest run --reporter=dot --reporter=json --outputFile="$wt/base-report.json" >/dev/null 2>&1) || true
  [ -s "$wt/base-report.json" ] || { echo "::error::could not regenerate the base inventory at $BASE_SHA"; exit 1; }
  node "$builder" --root "$wt" --out "$base_inventory" "$wt/base-report.json"
fi

git log --format=%B "$BASE_SHA..$HEAD_SHA" > "$work/declarations.txt"
mode=()
[ "$INVENTORY_GUARD" = enforce ] || mode=(--report-only)
node "$judge" "$base_inventory" "$head_inventory" --declarations "$work/declarations.txt" "${mode[@]}"
