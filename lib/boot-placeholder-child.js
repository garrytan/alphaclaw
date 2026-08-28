// Boot placeholder server, run as its OWN child process by bin/alphaclaw.js.
//
// It must be a separate process: the parent blocks its event loop for
// minutes at a time during boot (execSync npm install up to 3min, gog CLI
// download up to 2min, git fetches) — an in-process placeholder would accept
// TCP connections into the kernel backlog but never answer HTTP during
// exactly the windows it exists to cover.
//
// Bind retries cover the restart-overlap case (predecessor still inside its
// ≤10s drain window). The parent SIGTERMs this process right before the real
// server binds; the real server's EADDRINUSE retry covers the close/rebind
// race. If the parent dies without killing us, the orphan check exits.
const http = require("http");
const { createBootPlaceholderHandler } = require("./boot-placeholder.js");

const port =
  Number.parseInt(process.env.ALPHACLAW_PLACEHOLDER_PORT || "", 10) || 3000;
// Env-tunable stuck-boot window so the e2e suite can prove the 503 flip
// without waiting out 15 minutes.
const maxUpdatingWindowMs =
  Number.parseInt(process.env.ALPHACLAW_PLACEHOLDER_MAX_UPDATING_MS || "", 10) ||
  undefined;
const server = http.createServer(
  createBootPlaceholderHandler(
    maxUpdatingWindowMs ? { maxUpdatingWindowMs } : {},
  ),
);

let closed = false;
server.on("error", () => {
  if (closed) return;
  // Deliberately NOT unref'd: after a failed listen() this timer is the only
  // handle keeping the child alive — unref'd, the event loop drains and the
  // child exits before ever retrying, leaving no placeholder during exactly
  // the predecessor-still-draining overlap it exists to cover.
  setTimeout(() => {
    if (closed) return;
    try {
      server.listen(port, "0.0.0.0");
    } catch {}
  }, 2000);
});
server.listen(port, "0.0.0.0");

const shutdown = () => {
  if (closed) return;
  closed = true;
  try {
    server.closeAllConnections?.();
  } catch {}
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  // Deliberately NOT unref'd: hold the loop open until the bounded exit.
  setTimeout(() => process.exit(0), 1000);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

const parentPid = process.ppid;
const orphanCheck = setInterval(() => {
  if (process.ppid !== parentPid) shutdown();
}, 2000);
if (typeof orphanCheck.unref === "function") orphanCheck.unref();
