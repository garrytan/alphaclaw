// Deterministic HTTP boundaries around the real shipped Preact components.
// These adapters simulate provider responses; no Google/deployment call leaves
// localhost. Backend state/lease semantics are covered by the server suites.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { build } from "esbuild";

const entry = `
import { h, render } from "preact";
import { Google } from "./lib/public/js/components/google/index.js";
import { UpdateModal } from "./lib/public/js/components/update-modal.js";
import { GlobalRestartBanner } from "./lib/public/js/components/global-restart-banner.js";
import { ToastContainer } from "./lib/public/js/components/toast.js";
import { useAppShellController } from "./lib/public/js/hooks/use-app-shell-controller.js";
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
const page = location.pathname === "/google" ? Google : ManagedPage;
render(h("div", null, h(page, { gatewayStatus: "running" }), h(ToastContainer)), document.getElementById("app"));
`;

export const makeManagedAttempt = (state = "accepted", id = "managed-1") => ({
  id, state, requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  target: { repo: "fixture/template", ref: "main", alphaclawVersion: "1.1.0", openclawVersion: "2026.9.4" },
});

export async function createReliabilityFixture() {
  const bundle = await build({ bundle: true, write: false, format: "esm", stdin: { contents: entry, resolveDir: process.cwd() } });
  const css = ["theme.css", "tailwind.generated.css", "shell.css"]
    .map((name) => fs.readFileSync(path.join("lib/public/css", name), "utf8")).join("\n");
  const state = {
    role: "admin", gmailError: false, remoteStopFails: true,
    managedUpdateAttempt: null, currentVersion: "1.0.0",
    gmail: { accountId: "primary", enabled: true, running: true, remoteOperation: null },
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
