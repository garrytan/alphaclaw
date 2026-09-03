# AlphaClaw production container image.
#
# This file is BOTH:
#   1. the fixture the container E2E tier builds and boots
#      (tests/container/openclaw-container-upgrade.e2e.test.js), and
#   2. the reference production recipe from README.md.
#
# The E2E tier packs the local checkout with `npm pack` and injects the
# resulting tarball as alphaclaw.tgz (the ARG default). For production,
# install the published package instead:
#
#   RUN npm install --omit=dev alphaclaw
#
# in place of the COPY + tarball install below. Everything else is identical
# to what production runs: tini as PID 1, ALPHACLAW_ROOT_DIR on the /data
# volume, port 3000, and `alphaclaw start` (restartProcess() exits the
# process inside a container and relies on the orchestrator restart policy).
FROM node:22-slim
# tmux hosts the local Claude Code rescue session in a detached session that
# survives AlphaClaw process restarts (a human can also attach over SSH).
RUN apt-get update && apt-get install -y --no-install-recommends git curl procps cron tini tmux ca-certificates && rm -rf /var/lib/apt/lists/*
# Claude Code CLI for the local rescue session. PINNED on purpose: the
# TUI-parsing fixtures (tests/server/fixtures/claude-code-tui/) are captured
# per CLI version — bump this pin and refresh the fixtures together. Costs
# ~100-150MB; drop this line to run without the local rescue feature (it
# degrades to not_installed + the cloud-routine fallback). Kept above the
# tarball COPY so the layer stays cached across E2E rebuilds.
RUN npm install -g @anthropic-ai/claude-code@2.1.251
WORKDIR /app
ARG ALPHACLAW_PKG=alphaclaw.tgz
COPY ${ALPHACLAW_PKG} /tmp/alphaclaw.tgz
RUN npm install --omit=dev /tmp/alphaclaw.tgz && rm /tmp/alphaclaw.tgz
ENV PATH="/app/node_modules/.bin:$PATH"
ENV ALPHACLAW_ROOT_DIR=/data
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["alphaclaw","start"]
