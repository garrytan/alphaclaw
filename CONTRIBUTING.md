# Contributing to AlphaClaw

Thanks for your interest in contributing to AlphaClaw. This document covers how we work, what we value, and how to get your changes merged.

## Vision

AlphaClaw makes OpenClaw accessible: easy to deploy, easy to monitor, easy to repair, easy to keep running. Self-managed and open source, always.

One-click deployment templates come and go. The self-managed aspect is what makes this durable.

### Guiding Principles

- **UX over features.** Usability matters more than feature count. Every interaction should feel considered.
- **Smart defaults.** AlphaClaw is opinionated. We bootstrap hooks, prompt hardening, and sensible configs so the out-of-box experience is good without manual tuning.
- **Complement, don't replicate.** OpenClaw's Gateway dashboard is exhaustive. We surface the most common workflows and add net-new value, not duplicate switches.
- **Always ejectable.** AlphaClaw is not a dependency. Remove it and your OpenClaw instance keeps running. Nothing proprietary, nothing to migrate.
- **Reliability is a feature.** The watchdog, auto-repair, crash-loop recovery - these matter as much as any UI improvement.

## What We're Looking For

### Always welcome

- Bug fixes
- Reliability improvements (watchdog, crash recovery, gateway management)
- Test coverage
- Documentation fixes and clarifications

### Welcome, but reviewed carefully

- UX changes and small features
- New integrations or wizard steps
- Bootstrap prompt improvements

### Proposal first

- Large features or architectural changes
- New paradigms (e.g., plugin system changes, new deployment targets)
- Anything that changes the default experience significantly

For big changes, open an issue describing what you want to build, why, and your proposed approach. This saves everyone time.

## Getting Started

### Prerequisites

- Node.js >= 24.16.0 on Node 24, or >= 26.1.0 on Node 26 (Node 22 and 25 are no longer supported: OpenClaw 2026.9.3 requires 24.16+/26.1+)
- Git

### Setup

```bash
git clone https://github.com/chrysb/alphaclaw.git
cd alphaclaw
npm install
```

`npm install` also builds the browser bundle: the `prepare` script runs `npm run build:ui`, which writes the gitignored `lib/public/dist/`, `lib/public/css/tailwind.generated.css`, and `lib/public/css/vendor/` (xterm CSS copied from `node_modules`). Re-run `npm run build:ui` after any change under `lib/public/js/` or `lib/public/css/` before exercising the UI by hand (CI runs it before `npm test`).

### Running Tests

```bash
npm test              # Run all tests (hermetic — no network)
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
npm run test:watchdog # Watchdog-focused subset: watchdog core, incidents, overseer, memory monitor, machine summary, hermetic memory-leak e2e
npm run test:live     # Live e2e against the REAL pinned OpenClaw in node_modules: gateway, memory, CLI and gateway-stop contracts, Doctor fix dispatch, Back up now
npm run test:container # Container e2e: boot durability (incl. docker restart) + AlphaClaw self-upgrade from v0.9.76 (110-minute CI budget; needs docker + network)
npm run test:ui:reliability # Chromium recovery, deployment and Gmail journeys against local fixtures (needs build:ui + npx playwright install chromium)
npm run test:ui:time  # Browser smoke of UI time formatting — locale/timezone agnostic by construction (opt-in; same harness; UI_TIME_SMOKE_PORT overrides the port)
npm run test:ui:claude-code   # Browser smoke of the Open Claude Code launcher (opt-in; same harness)
npm run test:live:claude-code # Fires the real routine — BILLS one claude.ai session (needs the routine env vars + CLAUDE_CODE_LIVE_FIRE=1)
```

AlphaClaw uses [Vitest](https://vitest.dev/) for testing. `npm test` is hermetic by design: the live tiers under `tests/live/` run only with `OPENCLAW_LIVE_E2E=1` (the `test:live` scripts set it for you), so a green `npm test` does not exercise a real OpenClaw. The live tier drives the pinned OpenClaw that `npm install` put in `node_modules` (no registry installs) to catch the dist-coupled contracts a pin bump can break: `openclaw-live-gateway.e2e.test.js` (real gateway boot), `openclaw-live-memory.e2e.test.js` (a leaking plugin in a real gateway, seen by the RSS-trend sampler; its hermetic counterpart `tests/server/e2e-memory-leak.test.js` runs real child processes and is Linux-only), `openclaw-live-cli-contract.e2e.test.js` (the CLI flags and JSON envelopes the routes assume — `backup create --output/--verify/--json`, the `approvals` group and the `approvals get --json` `.file` wrapper), `openclaw-live-gateway-stop-contract.e2e.test.js` (the `gateway stop --force` capability probe), `doctor-fix-dispatch-contract.e2e.test.js` (the "Ask agent to fix" delivery flags) and `openclaw-live-backup.e2e.test.js` (**Back up now** through `openclaw backup create`). Every `--json` read goes through `runCliJson` in `tests/live/live-helpers.js`, which captures stdout and stderr separately and fails with the command, exit status and stderr quoted unless stdout is exactly one JSON document. The tier also includes a resource-autotune container smoke (`tests/live/autotune-container.e2e.test.js`) that needs a working Docker daemon — it validates real cgroup limits and V8 heap behavior inside `docker run --memory` and self-skips when Docker is unavailable — and the Control UI styles check in a real Chromium. Scratch roots are swept in `afterAll`; after an interrupted run, `rm -rf /tmp/alphaclaw-live-*` and check `df -h /`. `npm run test:container` (`tests/container/`) is the heaviest opt-in tier: it builds an image from the reference `Dockerfile` and proves boot durability (a fresh boot, `docker restart`, a legacy pidfile thread-ID collision and a dangling restart operation) and an immutable AlphaClaw v0.9.76 → candidate upgrade on one persistent volume, whose first boot retires the old version-switch overlay, runs the pin and migrates its databases with the once-per-pin `doctor --fix`. It needs docker plus network, and runs in CI nightly and, on pull requests, whenever the diff touches the boot journey the container exercises — `lib/server/openclaw-*`, `lib/server/boot-*`, `server-pidfile.js`, `gateway*`, `watchdog*`, `doctor*`, `diagnose/`, `routes/`, `startup.js`, `lib/server.js`, `bin/alphaclaw.js`, `lib/boot-placeholder*`, the `Dockerfile`, `tests/container/` and `login.html`, or the `openclaw` pin line in `package.json`; an always-reporting `gate` job is the required check, so unrelated PRs are not blocked (`.github/workflows/container-e2e.yml`).

The live tier requires Node 24.16+ (or 26.1+) first on `PATH`, like the pinned OpenClaw itself. See [cloud testing](docs/cloud-testing.md) for commands and measured evidence.

CI (`.github/workflows/ci.yml`) runs `npm test` on Node 24 and Node 26. The `main` ruleset's required checks are `test (24)` and `gate` (the always-running container-e2e aggregator in `.github/workflows/container-e2e.yml`); `test (26)` is a non-blocking early-warning lane (`continue-on-error`) until the ruleset lists it as required.

### Project Structure

- `bin/` - CLI entrypoint (`alphaclaw.js`)
- `lib/` - Core library (gateway manager, watchdog, setup UI, webhooks, etc.)
- `tests/` - Test suites
- `docs/` - Design documents (`docs/designs/`), plans (`docs/plans/`) and operator runbooks (e.g. `docs/upgrade-troubleshooting.md`)
- `scripts/` - Build and CI helpers: `build-ui.mjs` (Setup UI bundle), `ci/assert-version-advances.mjs` (the PR version guard), `refresh-model-bootstrap.mjs` (regenerates the onboarding model catalog) and `dev/` (operator harnesses)

## Submitting Changes

### Pull Request Process

1. Fork the repo and create a branch from `main`.
2. Make your changes. Write tests if applicable.
3. Run `npm test` and make sure everything passes. CI runs the suite on Node 24 (the required check) and Node 26 (an advisory, non-blocking lane).
4. Bump the version. CI's version guard (`scripts/ci/assert-version-advances.mjs`) fails any PR whose `package.json` version does not strictly advance `main`'s — every PR bumps, reverts included. Claim the next free number in your final pre-merge commit, keep `package-lock.json` in step, and add a matching `CHANGELOG.md` entry (see "Merge unification safety" in `CLAUDE.md`).
5. Write a clear PR description: what changed, why, and how to test it.
6. Sign off your commits (see DCO below).

### Commit Messages

Keep them clear and concise. Prefix with the area when it helps:

```text
watchdog: recover from port conflict on restart
setup-ui: fix credential validation for Gemini provider
docs: clarify Railway deployment steps
```

### Code Style

- Match the existing style. If something looks inconsistent, follow what the majority of the codebase does.
- No unnecessary dependencies. AlphaClaw ships lean on purpose.

## Developer Certificate of Origin (DCO)

We use the [DCO](https://developercertificate.org/) to certify that contributors have the right to submit their code under this project's MIT license.

Add a sign-off line to each commit:

```text
Signed-off-by: Your Name <your.email@example.com>
```

Git makes this easy:

```bash
git commit -s -m "your commit message"
```

The `-s` flag adds the sign-off automatically using your configured `user.name` and `user.email`.

## Code of Conduct

We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) (v2.1).

The short version: be respectful, be constructive, assume good intent. We're building something useful together.

## Questions?

Open an issue or start a discussion on the repo. We're happy to help you find the right place to contribute.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
