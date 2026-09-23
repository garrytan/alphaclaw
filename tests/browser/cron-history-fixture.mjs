import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import express from "express";

const require = createRequire(import.meta.url);
const { createCronService } = require("../../lib/server/cron-service");
const { closeCronStoreDb } = require("../../lib/server/cron-store");
const { registerCronRoutes } = require("../../lib/server/routes/cron");

export const createCronHistoryFixture = async (root, { port = 0 } = {}) => {
  const entry = `
    import { h, render } from "preact";
    import { CronTab } from "./lib/public/js/components/cron-tab/index.js";
    const jobId = decodeURIComponent(location.pathname.split("/")[2] || "");
    render(h(CronTab, { jobId, onSetLocation: (url) => { location.href = url; } }), document.getElementById("app"));
  `;
  const bundle = await build({ bundle: true, write: false, format: "esm", stdin: { contents: entry, resolveDir: process.cwd() } });
  const css = ["theme.css", "tailwind.generated.css", "shell.css", "explorer.css", "cron.css"]
    .map((name) => fs.readFileSync(path.join("lib/public/css", name), "utf8")).join("\n");
  const app = express();
  const requests = [];
  app.use((req, _res, next) => { requests.push({ method: req.method, path: req.path, query: req.query }); next(); });
  const cronService = createCronService({ OPENCLAW_DIR: root, getInstalledVersion: () => "2026.9.5",
    clawCmd: () => { throw new Error("Browser history fixture is read-only"); },
    getSessionUsageByKeyPattern: () => ({ totals: {}, modelBreakdown: [] }),
  });
  registerCronRoutes({ app, requireAuth: (_req, _res, next) => next(), cronService });
  app.get("/api/agent/sessions", (_req, res) => res.json({ ok: true, sessions: [] }));
  app.get("/bundle.js", (_req, res) => res.type("js").send(Buffer.from(bundle.outputFiles[0].contents)));
  app.get("/style.css", (_req, res) => res.type("css").send(css));
  app.get("/favicon.ico", (_req, res) => res.sendStatus(204));
  app.use("/api", (_req, res) => res.sendStatus(404));
  app.get("*", (_req, res) => res.type("html").send('<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><main id="app" style="height:100vh;max-width:1100px;margin:auto;padding:16px"></main><script type="module" src="/bundle.js"></script></body></html>'));
  const server = await new Promise((resolve) => {
    const listener = app.listen(port, "127.0.0.1", () => resolve(listener));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests,
    close: async () => { closeCronStoreDb(); await new Promise((resolve) => server.close(resolve)); },
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fixture = await createCronHistoryFixture(process.argv[2], { port: Number(process.env.PORT || 0) });
  console.log(fixture.url);
}
