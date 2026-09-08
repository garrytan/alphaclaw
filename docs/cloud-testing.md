# Testing in the cloud workspace

Real Docker works in the Amazon Linux 2023 cloud VM used for the September 8,
2026 reliability wave. Docker 25.0.16 runs with `overlay2`, cgroup v2, and an
isolated Unix socket and data directory. Memory limits are enforced by the
kernel; the autotune tests execute real Node processes inside containers.

## Use the prepared workspace

Run these commands from the checkout. Use Node 24.16+ from `.context/node24` for
everything: since v0.9.80 AlphaClaw's own `engines.node` is
`>=24.16.0 <25 || >=26.1.0` (the OpenClaw 2026.9.3 pin dropped Node 22 and 25),
so Node 22 no longer runs the server or the pinned CLI, and the default system
Node 24.14.1 does not satisfy the range either. Put the supported runtime first
on `PATH` so child processes and real upstream installs use it too. A fresh
workspace has no `.context/node24`: download the newest 24.x tarball from
nodejs.org into it (the previous sessions' `.context/` directories are not
shared between workspaces).

```bash
cd /home/vercel-sandbox/alphaclaw
export PATH="$PWD/.context/node24/bin:$PWD/.context/dev-build-toolchain/bin:$PATH"
export DOCKER_HOST="unix://$PWD/.context/docker/docker.sock"
node --version
docker info --format '{{.ServerVersion}} {{.Driver}} cgroup={{.CgroupVersion}}'
```

For a fresh checkout, install dependencies with `npm install`, then install the
browser matching the repository's installed Playwright with
`npx playwright install chromium`. A fresh VM also needs a supported Node
runtime and Docker (`sudo dnf install -y docker` on Amazon Linux).

Check actual resource enforcement before running the container suites:

```bash
docker run --rm --memory=512m --memory-swap=512m node:24-slim node -e '
  const fs = require("node:fs");
  console.log(JSON.stringify({
    memoryMax: fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
    swapMax: fs.readFileSync("/sys/fs/cgroup/memory.swap.max", "utf8").trim()
  }));
'
```

The verified output in this VM is `{"memoryMax":"536870912","swapMax":"0"}`.
`docker info` alone does not prove that a limited container can start.

## The cgroup obstacle and the working topology

The initial namespace root was `domain threaded`, with `conductor` and its
`workload` and `host-runtime` children all `threaded`. Docker could start its
daemon, but runc refused a container requesting domain controllers. The memory
controller cannot operate inside a threaded subtree. See the kernel's
[cgroup v2 thread-mode documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#threads).

The session-specific repair moved the threaded domain down to `conductor`,
restored its existing thread assignments and CPU limits, and gave Docker a
separate domain:

```text
/                         domain; domain controllers available
├── conductor             domain threaded; existing CPU limit and weight
│   ├── workload          threaded; existing CPU limit and thread placement
│   └── host-runtime      threaded; existing thread placement
├── alphaclaw-host         domain; other host processes
└── alphaclaw-docker       domain; Docker's container cgroups
```

The original layout and exact intervention are recorded locally in
[cgroup-before.json](../.context/docker/cgroup-before.json) and
[repair-cgroup-layout.py](../.context/docker/repair-cgroup-layout.py). These
gitignored files are evidence for this VM, not a portable setup script. The
repair assumes the inspected live topology and moves existing threads; do not
add it to automatic workspace setup or replay it on a different host. Inspect
that host's delegation and preserve its workload controls before choosing a
repair. Removing resource limits would invalidate the autotune coverage.

The daemon itself runs in `/alphaclaw-host`, and uses
`--cgroup-parent=/alphaclaw-docker` for containers. Both placements matter:
Docker checks swap-controller availability in its own cgroup. Starting it
inside Conductor's threaded group loses that capability even with the correct
container parent. If the daemon has stopped and the prepared domain topology
still exists, the following command moves only its new launcher into the host
domain and runs it in a dedicated terminal. Do not start a second daemon while
the existing socket responds.

```bash
sudo sh -c '
  set -e
  echo $$ > /sys/fs/cgroup/alphaclaw-host/cgroup.procs
  exec dockerd \
    --host="unix://$1/.context/docker/docker.sock" \
    --data-root="$1/.context/docker/data" \
    --exec-root="$1/.context/docker/run" \
    --pidfile="$1/.context/docker/dockerd.pid" \
    --exec-opt=native.cgroupdriver=cgroupfs \
    --cgroup-parent=/alphaclaw-docker
' alphaclaw-dockerd "$PWD" > .context/docker/daemon.log 2>&1
```

From the test terminal, after the socket appears, grant the workspace user
access with `sudo chown "$(id -u):$(id -g)" .context/docker/docker.sock` and
repeat the enforcement probe. Tests run as the workspace user. The daemon has
no TCP listener. Its state is confined to `.context/docker/data` and
`.context/docker/run`; preserve those directories while it is running.

## Run every unbilled tier

Use the environment above. Keep the heavy tiers serial unless disk and memory
headroom have been checked; a dev build alone requires at least 8 GiB free.
`pipefail` preserves test failures when saving logs.

```bash
set -o pipefail
npm test 2>&1 | tee .context/docker/hermetic-rerun.log
npm run build:ui 2>&1 | tee .context/docker/build-ui-rerun.log
npm run test:live 2>&1 | tee .context/docker/live-rerun.log
OPENCLAW_CONTAINER_E2E_STRICT=1 npm run test:container 2>&1 | tee .context/docker/container-rerun.log
npm run test:live:dev 2>&1 | tee .context/docker/live-dev-rerun.log
```

`npm test` is the hermetic suite. `test:live` adds real npm/GitHub/CLI/gateway
checks and, with this daemon available, the two resource-limited autotune
tests. It does not enable the full dev source build. `test:live:dev` separately
exercises OpenClaw's real clone/install/build/activation path from a disposable
global npm installation and needs Git, pnpm, network access, and build-grade
resources. It does not prove the shipped nested-dependency bootstrap: current
upstream refuses that invocation with “package manager owner is unknown.” The container tier packs the
checkout into production images, exercises persistent-volume boot recovery
and the immutable old-image self-upgrade, and includes the browser-driven
stable-to-beta journey. Paid Claude live-fire tests remain explicitly opt-in
through `test:live:claude-code`; they are excluded from these commands.

For focused Docker reruns:

```bash
OPENCLAW_LIVE_E2E=1 npx vitest run tests/live/autotune-container.e2e.test.js --no-file-parallelism
OPENCLAW_CONTAINER_E2E=1 npx vitest run tests/container/openclaw-container-boot-durability.e2e.test.js tests/container/alphaclaw-container-self-upgrade.e2e.test.js --no-file-parallelism
```

## Evidence and remaining coverage

Verified locally on September 8, 2026:

The log links below refer to this workspace's gitignored `.context` directory;
CI captures its own artifacts.

- Full hermetic suite: **487 files / 8,485 tests passed** under Node 22.22.3 (historical, v0.9.79 — since v0.9.80 the suite requires Node 24.16+)
  ([hermetic-serial.log](../.context/ci-fix/hermetic-serial.log)).
- Real Docker journeys: **3 files / 24 tests passed**, with no skipped steps:
  the full browser upgrade, immutable v0.9.76 → candidate activation, and
  actual thread-ID recovery
  ([container-final.log](../.context/ci-fix/container-final.log)).
- Real 512 MiB / 2 GiB resource limits and V8 exhaustion: **2 tests passed**
  ([autotune.log](../.context/docker/autotune.log)).
- Real source build, full commit identity, offline activation and execution:
  **2 tests passed** under Node 24.16 and pnpm 12.3.4
  ([live-dev.log](../.context/docker/live-dev.log)). This uses a disposable
  global installation; the production nested-bootstrap gap remains above.
- Real latest 2026.9.3 and beta apply, including calls to the activated thinking
  APIs: **2 tests passed**
  ([live-apply-final.log](../.context/ship/live-apply-final.log)).
- Full moving-target live tier: **14 files / 51 tests passed**, with four
  existing opt-in skips (the dev build was run separately; three paid Claude
  cases remain disabled)
  ([live-node24-final.log](../.context/docker/live-node24-final.log)).
- UI build and three real Chromium/Preact checks passed
  ([build log](../.context/docker/build-ui-final.log),
  [browser log](../.context/ship/browser-final.log)).

The full live run's memory case used its existing test retry. Its first start
captured an upstream plugin-migration convergence refusal that explicitly
requires another boot. The fixture now permits that exact, corroborated setup
transition once before measurement, preserves its evidence, and disables test
retries. The corrected fixture passed its focused run on the first test attempt
in 300.81 seconds, retaining the 256 MiB heap cap and original RSS/pressure
assertions ([live-memory-node24-final.log](../.context/docker/live-memory-node24-final.log)).

The first strict run failed before browser execution: `latest=2026.9.3`,
the bundled pin `2026.9.2`, and `beta=2026.9.1` offered no newer prerelease.
The browser journey now selects an explicit historical upgrade during this
registry gap: `2026.7.1-2 → 2026.9.1-beta.1`. It prepares the old stable as a
recorded overlay before any gateway opens the fresh volume, keeping the
production image and bundled pin unchanged. The old build's schema can migrate
forward to that beta; using `2026.8.x` would be incompatible despite its lower
package version. When a newer beta exists, the journey uses the shipped pin.
All 14 steps remain required, including the exact catalog selection, verified
backup under contention, orchestrator restart, live binary, readiness and both
durability legs. Missing/deprecated packages or registry failures still fail.
The restored journey also exposed an apply-admission defect: ordinary WAL
writes invalidated a verified-backup upgrade. Normal apply admission now checks
build and schema facts without requiring unchanged database bytes; human
no-backup consent retains its stricter database identity checks.

Failure captures go to [tests/container/artifacts](../tests/container/artifacts/);
daemon output is in [daemon.log](../.context/docker/daemon.log). Test helpers
remove their containers, named volumes, and staging directories. The immutable
and browser journeys also remove their image tags; the boot suite retains its
tags for explicit test-owned cleanup.
Inspect resources left by an interrupted run before removing only those
owned by the test. Do not use a host-wide Docker prune. Real OpenClaw installs
are intentionally retained in `~/.cache/alphaclaw-openclaw-cache` (or
`ALPHACLAW_LIVE_OPENCLAW_CACHE`); Vitest scratch directories are separate.
