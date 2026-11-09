// A Setup UI fixture for the Groups page (GST-1975 PR 2): the shipped
// GroupsTab against the real Telegram group rules routes
// (lib/server/routes/telegram-groups.js) on a scratch AlphaClaw root seeded
// with fake groups and people. OpenClaw's config check is stubbed to accept,
// and leaving one blocked group fails, so its error shows.
//
//   node tests/browser/groups-page-fixture.mjs [scenario]   # prints the URL
//   PORT=4100 node tests/browser/groups-page-fixture.mjs
//
// Scenarios: full (default), guard-off, unreadable, empty, unconfigured.
// GET /__fixture/<scenario> re-seeds a running fixture. Add ?theme=light to
// the page URL for the light theme. guard-off leaves the group guard plugin
// entry out of openclaw.json, so the server reports blocks as not enforced.
// Every id is fake.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import express from "express";

const require = createRequire(import.meta.url);
const kScenarios = ["full", "guard-off", "unreadable", "empty", "unconfigured"];
export const kOwner = "100000001";
export const kGroups = {
  family: "-1001111111111",
  falcon: "-1001111111112",
  core: "-1001111111113",
  bookClub: "-1001111111114",
  spam: "-1001111111115",
  market: "-1001111111116",
  imported: "-1001111111117",
  forum: "-1001111111118",
  weekend: "-1001111111119",
  neighbours: "-1001111111120",
};

export const createGroupsFixture = async ({ scenario = "full", port = 0 } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-groups-fixture-"));
  process.env.ALPHACLAW_ROOT_DIR = root;
  const { OPENCLAW_DIR, kRootDir } = require("../../lib/server/constants");
  const { createTelegramGroups, resolveStatePaths } = require("../../lib/server/telegram-groups");
  const { registerTelegramGroupRoutes } = require("../../lib/server/routes/telegram-groups");
  const { applyGroupGuardEntry } = require("../../lib/server/telegram-group-guard-entry");
  const configPath = path.join(OPENCLAW_DIR, "openclaw.json");
  const state = { scenario };
  const groups = createTelegramGroups({
    openclawDir: OPENCLAW_DIR,
    rootDir: kRootDir,
    validatePatch: async () => ({ ok: true, errors: [] }),
    telegramApi: {
      leaveChat: async (groupId) => {
        if (groupId === kGroups.market) throw new Error("Bad Gateway: Telegram did not answer");
      },
    },
    sleep: async () => {},
    log: () => {},
  });

  const writeConfig = (config) => {
    fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  };
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  const set = async (groupId, body) => {
    const revision = groups.list().groups.find((group) => group.groupId === groupId)?.revision || "";
    try {
      await groups.setPolicy({ groupId, body, ifMatch: revision });
    } catch (error) {
      if (error.code !== "leave_failed") throw error;
    }
  };
  const ago = (ms) => new Date(Date.now() - ms).toISOString();

  const seed = async (name) => {
    state.scenario = name;
    fs.rmSync(OPENCLAW_DIR, { recursive: true, force: true });
    fs.rmSync(path.join(kRootDir, "telegram"), { recursive: true, force: true });
    if (name === "unconfigured") {
      writeConfig({ commands: { ownerAllowFrom: ["telegram:" + kOwner] } });
      return;
    }
    const entries = name === "empty" ? { [kGroups.falcon]: { enabled: false } } : Object.fromEntries(Object.values(kGroups).slice(0, 8).map((id) => [id, { requireMention: true }]));
    if (name !== "empty") entries[kGroups.imported] = { requireMention: true, groupPolicy: "open", allowFrom: [kOwner, "100000009"], toolsBySender: { "*": { deny: ["exec"] } } };
    const config = {
      commands: { ownerAllowFrom: ["telegram:" + kOwner] },
      channels: { telegram: { enabled: true, botToken: "123456:fixture-token", dmPolicy: "allowlist", allowFrom: [kOwner], groupPolicy: "allowlist", groups: entries } },
    };
    if (name !== "guard-off") applyGroupGuardEntry(config, { rootDir: kRootDir, log: () => {} });
    writeConfig(config);
    if (name === "empty") return;
    await set(kGroups.family, { mode: "approved", convert: true, title: "Family chat", trusted: [{ id: "100000002", scope: "actions", label: "Alex" }, { id: "100000003", scope: "conversation", label: "Sam" }] });
    await set(kGroups.falcon, { mode: "approved", convert: true, title: "Project Falcon" });
    await set(kGroups.core, { mode: "trusted", convert: true, title: "Core team", trusted: [{ id: "100000004", scope: "actions", label: "Jordan" }] });
    await set(kGroups.bookClub, { mode: "silent", convert: true, title: "Book club" });
    await set(kGroups.forum, { mode: "silent", convert: true, title: "Forum with topics" });
    await set(kGroups.spam, { mode: "blocked", convert: true, title: "Spam lobby" });
    await set(kGroups.market, { mode: "blocked", convert: true, title: "Old marketplace" });
    const withTopics = readConfig();
    withTopics.channels.telegram.groups[kGroups.forum].topics = { 7: { allowFrom: ["100000005"], groupPolicy: "allowlist" }, 12: { enabled: true } };
    writeConfig(withTopics);
    groups.noteSeen(kGroups.imported, { title: "Imported group", firstSeenAt: ago(30 * 86_400_000), lastJoinAt: ago(30 * 86_400_000) });
    groups.noteSeen(kGroups.weekend, { title: "Weekend plans", firstSeenAt: ago(2 * 3_600_000), lastJoinAt: ago(2 * 3_600_000), lastJoinReason: "room-not-allowed", notifiedAt: ago(2 * 3_600_000) });
    groups.noteSeen(kGroups.neighbours, { title: "Neighbours", firstSeenAt: ago(26 * 3_600_000), lastJoinAt: ago(26 * 3_600_000), lastJoinReason: "room-not-allowed" });
    groups.setBlockedSenders({ senders: [{ id: "100000007", label: "Spam bot" }, { id: "100000008", label: "Pat" }] });
    if (name === "unreadable") fs.writeFileSync(resolveStatePaths(kRootDir).statePath, "{ this is not json");
  };

  await seed(scenario);
  const entry = `
    import { h, render } from "preact";
    import { GroupsTab } from "./lib/public/js/components/groups-tab/index.js";
    import { ToastContainer } from "./lib/public/js/components/toast.js";
    render(h("div", null, h(GroupsTab, { accountId: "default" }), h(ToastContainer)), document.getElementById("app"));
  `;
  const bundle = await build({ bundle: true, write: false, format: "esm", stdin: { contents: entry, resolveDir: process.cwd() } });
  const css = ["theme.css", "tailwind.generated.css", "shell.css"].map((name) => fs.readFileSync(path.join("lib/public/css", name), "utf8")).join("\n");
  const app = express();
  const requests = [];
  app.use(express.json());
  app.use((req, _res, next) => {
    requests.push({ method: req.method, path: req.path, body: req.body, ifMatch: req.get("if-match") || null });
    next();
  });
  registerTelegramGroupRoutes({ app, telegramGroups: groups });
  app.get("/__fixture/:scenario", async (req, res) => {
    if (!kScenarios.includes(req.params.scenario)) return res.status(404).json({ ok: false, scenarios: kScenarios });
    await seed(req.params.scenario);
    res.json({ ok: true, scenario: state.scenario });
  });
  app.get("/bundle.js", (_req, res) => res.type("js").send(Buffer.from(bundle.outputFiles[0].contents)));
  app.get("/style.css", (_req, res) => res.type("css").send(css));
  app.get("/favicon.ico", (_req, res) => res.sendStatus(204));
  app.use("/api", (_req, res) => res.sendStatus(404));
  app.get("*", (_req, res) =>
    res.type("html").send(
      '<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<script>if (new URLSearchParams(location.search).get("theme") === "light") document.documentElement.dataset.theme = "light";</script>' +
        '<link rel="stylesheet" href="/style.css"></head><body class="text-body" style="background:var(--bg-content)">' +
        '<main id="app" style="max-width:1120px;padding:16px 40px"></main><script type="module" src="/bundle.js"></script></body></html>',
    ),
  );
  const server = await new Promise((resolve) => {
    const listener = app.listen(port, "127.0.0.1", () => resolve(listener));
  });
  return {
    url: "http://127.0.0.1:" + server.address().port,
    requests,
    seed,
    readConfig,
    readState: () => groups.readState(),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const scenario = process.argv[2] || "full";
  if (!kScenarios.includes(scenario)) {
    console.error("Unknown scenario " + scenario + "; use one of " + kScenarios.join(", "));
    process.exit(2);
  }
  const fixture = await createGroupsFixture({ scenario, port: Number(process.env.PORT || 0) });
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(fixture.url + "  (scenario " + scenario + "; GET /__fixture/<scenario> to switch)");
}
