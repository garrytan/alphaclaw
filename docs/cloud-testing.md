# Testing in the cloud workspace

Real Docker works in the Amazon Linux 2023 Conductor cloud VM, verified again
on September 9, 2026 while implementing issue #85. Docker 25.0.16 runs with
`overlay2`, cgroup v2, and an isolated Unix socket and data directory. Memory limits are enforced by the
kernel; the autotune tests execute real Node processes inside containers.

## Use the prepared workspace

Run these commands from the checkout. Use supported Node from `.context/node24`
or `/opt/alphaclaw-node` for the application and tests. Since v0.9.80,
AlphaClaw's `engines.node` is
`>=24.16.0 <25 || >=26.1.0` (the OpenClaw 2026.9.3 pin dropped Node 22 and 25),
so Node 22 no longer runs the server or the pinned CLI, and the default system
Node 24.14.1 does not satisfy the range either. Put the supported runtime first
on `PATH` so child processes and real upstream installs use it too. A fresh
workspace has no `.context/node24`: download the newest 24.x tarball from
nodejs.org into it (the previous sessions' `.context/` directories are not
shared between workspaces).

```bash
cd /home/vercel-sandbox/alphaclaw
export PATH="$PWD/.context/node24/bin:/opt/alphaclaw-node/bin:$PWD/.context/dev-build-toolchain/bin:$PATH"
export DOCKER_HOST="unix://$PWD/.context/docker/docker.sock"
node --version
docker info --format '{{.ServerVersion}} {{.Driver}} cgroup={{.CgroupVersion}}'
```

For a fresh checkout, install dependencies with `npm install`, then install the
browser matching the repository's installed Playwright with
`npx playwright install chromium`. A fresh VM also needs a supported Node
runtime and Docker (`sudo dnf install -y docker` on Amazon Linux). In the
September 9 checkout, Playwright 1.55 required Chromium revision 1187; the VM's
existing revision 1234 did not satisfy that installation.

If browser installation reaches 100% and hangs during extraction on Node
24.16.0, this matches the upstream [Node extract-zip issue](https://github.com/nodejs/node/issues/63487)
and [Playwright report](https://github.com/microsoft/playwright/issues/41000).
Stop only the stuck installer and its download child, then run the repository's
installer with the VM's preinstalled Node 24.14.1:

```bash
/usr/local/bin/node node_modules/playwright/cli.js install chromium
```

This downloads and installs the exact pinned browsers normally; it does not
change dependencies or create cache completion markers by hand. The older
runtime is used only for browser installation. Keep supported Node first on
`PATH` for AlphaClaw, OpenClaw, npm installs, and every test. This workaround
completed both Chromium and headless-shell installation in the September 9 VM.

Check actual resource enforcement before running the container suites:

```bash
docker run --rm --memory=512m --memory-swap=512m node:24-slim node -e '
  const fs = require("node:fs");
  const memoryMax = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
  const swapMax = fs.readFileSync("/sys/fs/cgroup/memory.swap.max", "utf8").trim();
  if (memoryMax !== "536870912" || swapMax !== "0") throw Error("limits not enforced");
  console.log(JSON.stringify({ node: process.version, memoryMax, swapMax }));
  fetch("https://registry.npmjs.org/openclaw/latest")
    .then(response => { if (!response.ok) throw Error(response.status); return response.json(); })
    .then(pkg => console.log("container HTTPS: OpenClaw " + pkg.version));
'
```

The September 9 probe reported Node **24.20.0**, `memoryMax: "536870912"`,
`swapMax: "0"`, and a successful npm HTTPS response. `docker info` alone does
not prove that a limited container can start. Pull `node:24-slim` again if a
cached image contains a Node version below the supported range.

## The cgroup obstacle and the working topology

The initial namespace root was `domain threaded`, with `conductor` and its
`workload` and `host-runtime` children all `threaded`. Docker could start its
daemon, but runc refused a container requesting domain controllers. The memory
controller cannot operate inside a threaded subtree. See the kernel's
[cgroup v2 thread-mode documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#threads).

The repair moves the threaded domain down to `conductor`, restores its
existing thread assignments and CPU limits, and gives Docker a separate domain:

```text
/                         domain; domain controllers available
├── conductor             domain threaded; existing CPU limit and weight
│   ├── workload          threaded; existing CPU limit and thread placement
│   └── host-runtime      threaded; existing thread placement
├── alphaclaw-host         domain; other host processes
└── alphaclaw-docker       domain; Docker's container cgroups
```

The reproducible helper is tracked at
[scripts/dev/prepare-cloud-cgroups.py](../scripts/dev/prepare-cloud-cgroups.py).
Run its read-only check first. On a fresh VM matching the original topology,
stop any previously started Docker daemon and perform the explicit repair
before starting test jobs:

```bash
python3 scripts/dev/prepare-cloud-cgroups.py --check
sudo python3 scripts/dev/prepare-cloud-cgroups.py --apply
```

The helper refuses unknown layouts and active Docker during a repair. It saves
original process/thread identities and controller settings in a new directory
under `.context/docker/cgroup-repair-*`, preserving that evidence, then verifies
the final topology and surviving thread placements. On an already prepared
layout it only checks and exits, including with `--apply`. Do not add this
manual host repair to automatic workspace setup or weaken its topology checks
for an unfamiliar host.

The kernel permits `domain → threaded` but not the reverse. The repair therefore
moves Conductor processes temporarily, removes and recreates its groups, empties
the namespace root into `/alphaclaw-host`, and then enables domain controllers.
It moves complete processes into the rebuilt Conductor domain before restoring
individual threads to their original children. The namespace root's existing
memory and PID limits remain unchanged. Conductor's CPU quotas and weights
are restored and verified after its groups are recreated; they are temporarily
absent during migration, which is why this repair precedes long test jobs.
The September 9 verification preserved `conductor` at **700000/100000**, weight
**10**, and `workload` at **600000/100000**, weight **100**; these are observed
values, not constants the helper imposes on another VM. Removing resource limits
would invalidate the autotune coverage.

The daemon itself runs in `/alphaclaw-host`, and uses
`--cgroup-parent=/alphaclaw-docker` for containers. Both placements matter:
Docker checks swap-controller availability in its own cgroup. Starting it
inside Conductor's threaded group loses that capability even with the correct
container parent. If the daemon has stopped and the prepared domain topology
still exists, the following command moves only its new launcher into the host
domain and runs it in a dedicated terminal. Do not start a second daemon while
the existing socket responds.

```bash
mkdir -p .context/docker
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
access with `sudo chown "$(id -u):$(id -g)" .context/docker/docker.sock`, export
`DOCKER_HOST="unix://$PWD/.context/docker/docker.sock"`, and repeat the enforcement
probe. Keep Docker's bridge and iptables support enabled: `--bridge=none` or
`--iptables=false` prevents the full suite's published ports and outbound
container networking from working. Tests run as the workspace user. The daemon has
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

Verified in the September 9, 2026 workspace:

- Full strict container tier: **3 files / 24 tests passed**, with no skips,
  in **465 seconds**. This includes the browser upgrade, real thread-ID boot
  recovery, and immutable old-image self-upgrade
  ([container log](../.context/docker/container.log)).
- Real Docker memory/swap enforcement and outbound HTTPS passed on Node
  **24.20.0** inside `node:24-slim`.
- The guarded helper passed **10 hermetic Python tests** and an actual repair
  in an isolated mount/PID/cgroup namespace. That kernel check preserved split
  thread assignments, CPU quotas, a **512 MiB** root memory limit, and a
  **256-task** PID limit; a second `--apply` made no changes
  ([kernel log](../.context/docker/helper-kernel.log)). Run the helper's hermetic
  checks with `python3 -B tests/scripts/test_prepare_cloud_cgroups.py`.
- Both real autotune tests passed, including V8 exhaustion
  ([autotune log](../.context/docker/autotune-final.log)). Node 24's total heap
  includes young space: the old 64 MiB tolerance failed for a 1024 MiB old-space
  cap with a 1120 MiB total. The fixture now controls semi-space and asserts
  exact total bytes, following [Node's documented sizing](https://nodejs.org/api/cli.html#--max-semi-space-sizesize-in-mib).
  An operator override additionally proves that ignoring the old-space flag
  fails. Production tuning is unchanged.
- The pinned Playwright browsers installed successfully using the installer
  workaround above, then launched under supported Node **24.16.0**.

These September 9 logs are local, gitignored artifacts. The September 8 links
below are **historical artifacts from an earlier workspace** and may be absent
in a fresh checkout; the tracked helper and commands above are the reusable
procedure. CI captures its own artifacts.

Verified locally on September 8, 2026:

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
