// Deterministic HTTP boundaries around the real shipped Preact components.
// These adapters simulate provider responses; no Google/deployment call leaves
// localhost. Backend state/lease semantics are covered by the server suites.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const { resolveBackupPolicy } = require("../../lib/server/openclaw-backup-policy");

const entry = `
import { h, render } from "preact";
import { UpgradeTabView } from "./lib/public/js/components/upgrade-tab/index.js";
import { useUpgradeTab } from "./lib/public/js/components/upgrade-tab/use-upgrade-tab.js";
import { Google } from "./lib/public/js/components/google/index.js";
import { UpdateModal } from "./lib/public/js/components/update-modal.js";
import { GlobalRestartBanner } from "./lib/public/js/components/global-restart-banner.js";
import { ToastContainer } from "./lib/public/js/components/toast.js";
import { useAppShellController } from "./lib/public/js/hooks/use-app-shell-controller.js";
function UpgradePage() { return h(UpgradeTabView, { state: useUpgradeTab() }); }
function ManagedPage() {
  const controller = useAppShellController({ location: "/general" });
  const s = controller.state;
  return h("div", null, h(GlobalRestartBanner), h(UpdateModal, {
    visible: true, currentVersion: s.acVersion, currentOpenclawVersion: s.acCurrentOpenclawVersion,
    version: s.acLatest, latestOpenclawVersion: s.acLatestOpenclawVersion,
    updateStrategy: s.acUpdateStrategy, managedUpdate: s.acManagedUpdate,
    onUpdate: controller.actions.handleAcUpdate, updating: s.acUpdating,
  }));
}
const page = location.pathname === "/managed" ? ManagedPage : location.pathname === "/google" ? Google : UpgradePage;
render(h("div", null, h(page, { gatewayStatus: "running" }), h(ToastContainer)), document.getElementById("app"));
`;

const release = (version, channel = "stable") => ({
  version, publishedAt: "2026-09-10T12:00:00Z", isDistTagLatest: true,
  notes: "A fixture release for browser recovery coverage.",
  applyPayload: { channel, version },
});
const makeRun = (operationId, target, state = "running") => ({
  operationId, target, state, startedAt: Date.now(), finishedAt: null,
  ok: null, steps: [], hasLog: false,
});
export const makeManagedAttempt = (state = "accepted", id = "managed-1") => ({
  id, state, requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  target: { repo: "fixture/template", ref: "main", alphaclawVersion: "1.1.0", openclawVersion: "2026.9.4" },
});

export async function createReliabilityFixture() {
  const bundle = await build({ bundle: true, write: false, format: "esm", stdin: { contents: entry, resolveDir: process.cwd() } });
  const css = ["theme.css", "tailwind.generated.css", "shell.css"]
    .map((name) => fs.readFileSync(path.join("lib/public/css", name), "utf8")).join("\n");
  const state = {
    role: "admin", releaseChannel: "dev", runs: [], lastUpdateRun: null,
    catalogError: false, channelError: false, gmailError: false, remoteStopFails: true,
    managedUpdateAttempt: null, currentVersion: "1.0.0",
    gmail: { accountId: "primary", enabled: true, running: true, remoteOperation: null },
    backupPolicy: { excludes: [...resolveBackupPolicy().excludes], rootExcludes: [] },
    backupProfile: "full", backupStreamed: false, backupArchives: [],
    backupPreflightError: false,
    backupPreflight: { ok: true, blocked: false, reason: null, diagnosis: { directories: {
      complete: true, entries: 12, bytes: 1024, rootSymlink: false, absoluteSymlinkCount: 0, absoluteSymlinks: [],
      topLevel: [{ path: "workspace", entries: 12, bytes: 1024 }], topEntries: [], topBytes: [],
    } } },
    applyFailureCode: "build_failed", applyFailureMessage: "Fixture build failed",
  };
  const requests = [];
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;
    let body = {};
    if (req.method === "POST" || req.method === "PUT") {
      let raw = ""; for await (const chunk of req) raw += chunk;
      body = raw ? JSON.parse(raw) : {};
    }
    requests.push({ method: req.method, path: route, body });
    const json = (data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    const error = (message) => json({ ok: false, error: message, code: "fixture_unavailable" }, 503);
    if (route === "/bundle.js") { res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(bundle.outputFiles[0].contents); }
    if (route === "/style.css") { res.writeHead(200, { "Content-Type": "text/css" }); return res.end(css); }
    if (route === "/favicon.ico") { res.writeHead(204); return res.end(); }
    if (!route.startsWith("/api/")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end('<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="app" style="max-width:900px;margin:24px auto;padding:16px"></main><script type="module" src="/bundle.js"></script></body></html>');
    }
    if (route === "/api/openclaw/channel") {
      if (req.method === "PUT") { state.releaseChannel = body.releaseChannel || body.channel; return json({ ok: true }); }
      if (state.channelError) return error("Fixture channel status unavailable");
      return json({ ok: true, releaseChannel: state.releaseChannel, installedVersion: "2026.9.3", pinVersion: "2026.9.3", nodeVersion: "24.21.0",
        applied: { channel: "dev", sha: "abcdef0123456789" }, appliedId: "abcdef0123456789", isPin: false, blocklist: [], lastUpdateRun: state.lastUpdateRun });
    }
    if (route === "/api/openclaw/catalog") {
      if (state.catalogError) return error("Fixture catalog status unavailable");
      return json({ ok: true, whatsNew: { channel: "stable", securityFlips: Array.from({ length: 12 }, (_, index) => ({
        key: `fixture.security.setting${index}`, from: "disabled", to: "enabled",
        warning: "Review the effect of this setting before confirming the version change.",
      })) }, catalog: { staleAsOf: Date.now(), degraded: {}, distTags: { latest: "2026.9.4" },
        stable: [release("2026.9.4")], beta: [release("2026.9.4-beta.1", "beta")], dev: { commits: [] } } });
    }
    if (route === "/api/openclaw/runs") return json({ ok: true, runs: state.runs });
    if (/^\/api\/openclaw\/runs\/[^/]+$/.test(route)) {
      const run = state.runs.find((entry) => entry.operationId === route.split("/").at(-1));
      return run ? json({ ok: true, run }) : json({ ok: false, error: "Run not found" }, 404);
    }
    if (route === "/api/openclaw/apply") {
      const run = makeRun("apply-before-repair", body); state.runs.unshift(run); state.lastUpdateRun = run;
      return json({ ok: true, operationId: run.operationId, events: `/api/operations/${run.operationId}/events` }, 202);
    }
    if (route === "/api/openclaw/repair") {
      const run = makeRun("repair-current", { channel: "dev", repair: true }); state.runs.unshift(run);
      return json({ ok: true, operationId: run.operationId, events: `/api/operations/${run.operationId}/events` }, 202);
    }
    if (route === "/api/openclaw/backup-preflight") {
      if (state.backupPreflightError) return error("Fixture backup source scan failed. Retry the preflight.");
      return json(state.backupPreflight);
    }
    if (route === "/api/openclaw/backup-policy") {
      if (req.method === "PUT") {
        const resolved = resolveBackupPolicy(body);
        if (resolved.refused.length) return json({ ok: false, code: "invalid_backup_policy",
          message: "Some exclusions could omit protected data. Nothing was changed.", refusedExcludes: resolved.refused }, 400);
        state.backupPolicy = { excludes: [...resolved.excludes], rootExcludes: [...resolved.rootExcludes] };
      }
      return json({ ok: true, policy: state.backupPolicy,
        defaults: { excludes: [...resolveBackupPolicy().excludes], rootExcludes: [] }, refusedExcludes: [] });
    }
    if (route === "/api/openclaw/backup") {
      const operationId = `manual-${state.runs.length + 1}`;
      const run = makeRun(operationId, { kind: "backup" });
      const minimal = state.backupProfile === "migration-minimal";
      const archive = { file: `/backups/${operationId}.alphaclaw.tar.gz`, at: run.startedAt,
        profile: state.backupProfile, verified: true, partial: minimal, producer: "alphaclaw-offline-copy",
        coverage: minimal ? { migration: "complete", core: "partial", workspace: "omitted" } : { core: "complete", workspace: "complete" },
        partialReasons: minimal ? ["workspace and other state omitted"] : [],
        snapshotStartedAt: run.startedAt, snapshotCompletedAt: run.startedAt + 20 };
      run.result = { ok: true, archive };
      state.runs.unshift(run);
      state.backupArchives.unshift({ ...archive, exists: true, eligible: !minimal, ineligibleReason: minimal ? "partial" : null, sizeBytes: 4096 });
      if (state.backupStreamed) return json({ ok: true, operationId, events: `/api/operations/${operationId}/events` }, 202);
      Object.assign(run, { state: "completed", ok: true, finishedAt: Date.now() });
      return json({ ...run.result, operationId });
    }
    if (/^\/api\/operations\/.+\/events$/.test(route)) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const run = state.runs.find((entry) => entry.operationId === route.split("/")[3]);
      if (!run) return res.end();
      if (run.target.kind === "backup") {
        Object.assign(run, { state: "completed", ok: true, finishedAt: Date.now() });
        run.steps = [{ name: "backup", status: run.result.archive.partial ? "warning" : "completed", at: Date.now(),
          detail: run.result.archive.partial ? "Verified migration-only backup; workspace and other state omitted" : "Backup verified" }];
        res.write(`event: step\ndata: ${JSON.stringify(run.steps[0])}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ ...run.result, operationId: run.operationId })}\n\n`);
        return res.end();
      }
      if (run.target.repair) {
        run.steps = [{ name: "repair", status: "running", at: Date.now() }];
        res.write(`event: step\ndata: ${JSON.stringify(run.steps[0])}\n\n`);
        // Real EventSource transport loss, deliberately no terminal frame.
        return setTimeout(() => res.end(), 75);
      }
      Object.assign(run, { state: "failed", ok: false, finishedAt: Date.now(), result: { message: state.applyFailureMessage, code: state.applyFailureCode } });
      res.write(`event: error\ndata: ${JSON.stringify({ error: state.applyFailureMessage, code: state.applyFailureCode })}\n\n`);
      return res.end();
    }
    if (route === "/api/openclaw/backups") return json({ ok: true, entries: state.backupArchives, readable: true });
    if (route === "/api/openclaw/overseer") return json({ ok: true, enabled: false, availability: { available: false, message: "Fixture mode" } });
    if (route === "/api/openclaw/medic") return json({ ok: true, enabled: false });
    if (route === "/api/alphaclaw/version") return json({ currentVersion: state.currentVersion, currentOpenclawVersion: "2026.9.3", latestVersion: "1.1.0", latestOpenclawVersion: "2026.9.4", hasUpdate: state.currentVersion !== "1.1.0", managedUpdateAttempt: state.managedUpdateAttempt,
      updateStrategy: { action: "managed-update", provider: "apex", label: "Fixture provider", primaryActionLabel: "Update now" } });
    if (route === "/api/alphaclaw/release-notes") return json({ ok: true, body: "Browser fixture release notes." });
    if (route === "/api/alphaclaw/update") {
      state.managedUpdateAttempt = makeManagedAttempt();
      return json({ ok: true, managedUpdate: true, restarting: false, phase: "queued", managedUpdateAttempt: state.managedUpdateAttempt });
    }
    if (/^\/api\/alphaclaw\/update\/.+\/resolve$/.test(route)) {
      if (state.role !== "admin") return json({ ok: false, code: "admin_required" }, 403);
      if (route.split("/")[4] !== state.managedUpdateAttempt?.id || body.confirmProviderChecked !== true) return json({ ok: false, code: "attempt_stale" }, 409);
      state.managedUpdateAttempt = { ...state.managedUpdateAttempt, state: "resolved", resolution: { outcome: body.outcome, at: new Date().toISOString(), source: "operator" } };
      return json({ ok: true, managedUpdateAttempt: state.managedUpdateAttempt });
    }
    if (route === "/api/google/accounts") return json({ accounts: [{ id: "primary", client: "default", email: "operator@example.test", authenticated: true, activeScopes: ["gmail:read"] }], hasCompanyCredentials: true });
    if (route === "/api/google/check") return json({ ok: true, results: {} });
    if (route === "/api/gmail/config") return state.gmailError ? error("Fixture Gmail status unavailable") : json({ ok: true, accounts: [state.gmail], clients: [] });
    if (route === "/api/gmail/watch/stop") {
      state.gmail = { ...state.gmail, enabled: false, running: false, remoteOperation: state.remoteStopFails
        ? { kind: "stop", status: "failed", message: "Google could not confirm the remote stop" } : null };
      return state.remoteStopFails ? error("Disabled locally; Google stop failed") : json({ ok: true });
    }
    if (route === "/api/auth/identity") return json({ identity: { role: state.role } });
    if (route === "/api/auth/status") return json({ authEnabled: false });
    if (route === "/api/onboard/status") return json({ onboarded: true });
    if (route === "/api/restart-status") return json({ restartRequired: false, restartInProgress: false, reasons: [] });
    if (route === "/api/events/status") {
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": fixture connected\n\n");
      streams.add(res); req.on("close", () => streams.delete(res)); return;
    }
    if (route === "/api/status") return json({ gateway: "running", alphaclawVersion: state.currentVersion });
    if (route === "/api/watchdog/status" || route === "/api/doctor/status") return json({ status: { health: "healthy" } });
    return json({ ok: false, error: `Unimplemented fixture route ${route}` }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { state, requests, url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  } };
}
