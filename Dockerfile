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
RUN apt-get update && apt-get install -y --no-install-recommends git curl procps cron tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG ALPHACLAW_PKG=alphaclaw.tgz
COPY ${ALPHACLAW_PKG} /tmp/alphaclaw.tgz
RUN npm install --omit=dev /tmp/alphaclaw.tgz && rm /tmp/alphaclaw.tgz
ENV PATH="/app/node_modules/.bin:$PATH"
ENV ALPHACLAW_ROOT_DIR=/data
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["alphaclaw","start"]
