const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { buildToolsMissingCard } = require("../../lib/server/doctor/tools-missing-card");
const { buildDeterministicCards } = require("../../lib/server/doctor/deterministic-checks");
const { analyzeBootstrapContext } = require("../../lib/server/doctor/bootstrap-context");
const { kCurrentContextProfile } = require("../../lib/server/doctor/context-profiles");
const { registerDoctorRoutes } = require("../../lib/server/routes/doctor");
const { listOps } = require("../../lib/server/admin-manifest");

const kContainerId = "b".repeat(32);
const kRepoRoot = path.join(__dirname, "..", "..");
const readSource = (...segments) => fs.readFileSync(path.join(kRepoRoot, ...segments), "utf8");

const status = (outstanding) => ({ containerId: kContainerId, binDir: "/data/.openclaw/bin", outstanding });
const entry = (name, kind) => ({ name, kind, missingSince: "2026-11-09T08:33:00.000Z", containerId: kContainerId });

describe("doctor: tools-missing card", () => {
  it("lists the outstanding names by kind under a container-scoped sourceKey", () => {
    const [card, ...rest] = buildToolsMissingCard(status([entry("tree", "hand_install_lost"), entry("ffprobe", "hand_install_lost"), entry("rg", "image_dropped")]));
    expect(rest).toEqual([]);
    expect(card).toMatchObject({
      sourceKey: "det:tools-missing:" + kContainerId,
      priority: "P1",
      category: "workspace state",
      title: "Tools went missing in a rebuild",
      targetPaths: [],
    });
    expect(card.summary).toBe(
      "Installed by hand inside an earlier container and removed by a redeploy: tree, ffprobe. No longer shipped by the image: rg. " +
        "Commands and skills that call them fail until they are back.",
    );
    expect(card.recommendation).toContain("Ask for them to be added to the image, or put a statically linked copy in /data/.openclaw/bin.");
    expect(card.evidence.map((item) => item.text)).toEqual([
      "tree: hand install lost since 2026-11-09T08:33:00.000Z",
      "ffprobe: hand install lost since 2026-11-09T08:33:00.000Z",
      "rg: dropped from the image since 2026-11-09T08:33:00.000Z",
    ]);
    expect(card.fixPrompt).toContain("not a dynamic executable");
    expect(card.fixPrompt).toContain("Never use apt-get or npm -g");
  });

  it("emits nothing without outstanding names or a container id", () => {
    expect(buildToolsMissingCard(null)).toEqual([]);
    expect(buildToolsMissingCard(status([]))).toEqual([]);
    expect(buildToolsMissingCard({ ...status([entry("tree", "hand_install_lost")]), containerId: "../x" })).toEqual([]);
  });

  it("rides the deterministic pass", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tools-missing-card-"));
    try {
      const cards = buildDeterministicCards({
        workspaceRoot,
        managedRoot: workspaceRoot,
        profile: kCurrentContextProfile,
        bootstrapContext: analyzeBootstrapContext({ workspaceRoot, profile: kCurrentContextProfile }),
        onboarded: true,
        toolInventory: status([entry("tree", "hand_install_lost")]),
      });
      const card = cards.find((item) => item.sourceKey.startsWith("det:tools-missing:"));
      expect(card).toMatchObject({ source: "deterministic", status: "open", title: "A tool went missing in a rebuild" });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("doctor routes: dismissing the tools-missing card", () => {
  const createApp = ({ actorType = null, sourceKey = "det:tools-missing:" + kContainerId } = {}) => {
    const doctorService = {
      getDoctorCard: vi.fn(() => ({ id: 9, sourceKey })),
      setCardStatus: vi.fn(({ cardId, status: next }) => ({ id: Number(cardId), status: next, sourceKey })),
    };
    const dismissToolsMissing = vi.fn(() => ({ cleared: 2 }));
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      if (actorType) req.alphaclawActor = { type: actorType };
      next();
    });
    registerDoctorRoutes({ app, requireAuth: (req, res, next) => next(), doctorService, dismissToolsMissing });
    return { app, doctorService, dismissToolsMissing };
  };

  it("lets a person dismiss it and forgets its names", async () => {
    const { app, doctorService, dismissToolsMissing } = createApp();
    const res = await request(app).post("/api/doctor/cards/9/status").send({ status: "dismissed" });
    expect(res.status).toBe(200);
    expect(doctorService.setCardStatus).toHaveBeenCalledWith({ cardId: "9", status: "dismissed" });
    expect(dismissToolsMissing).toHaveBeenCalledWith(kContainerId);
  });

  it("refuses the agent (humans only) and changes nothing", async () => {
    const { app, doctorService, dismissToolsMissing } = createApp({ actorType: "agent" });
    const res = await request(app).post("/api/doctor/cards/9/status").send({ status: "dismissed" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, code: "denied" });
    expect(doctorService.setCardStatus).not.toHaveBeenCalled();
    expect(dismissToolsMissing).not.toHaveBeenCalled();
  });

  it("leaves other cards and other statuses to the plain status route", async () => {
    const other = createApp({ actorType: "agent", sourceKey: "det:disk-space-low:disk-state-1" });
    expect((await request(other.app).post("/api/doctor/cards/9/status").send({ status: "dismissed" })).status).toBe(200);
    expect(other.dismissToolsMissing).not.toHaveBeenCalled();
    const fixed = createApp({ actorType: "agent" });
    expect((await request(fixed.app).post("/api/doctor/cards/9/status").send({ status: "fixed" })).status).toBe(200);
    expect(fixed.doctorService.getDoctorCard).not.toHaveBeenCalled();
    expect(fixed.dismissToolsMissing).not.toHaveBeenCalled();
  });

  it("tells the agent in the manifest that this dismissal is for a person", () => {
    const op = listOps().find((item) => item.id === "doctor.card-status");
    expect(op.path).toBe("/api/doctor/cards/:id/status");
    expect(op.params.fields.find((field) => field.name === "status").description).toContain("(sourceKey det:tools-missing:*) is for a person only (403).");
  });
});

describe("lib/server.js wiring of the rebuild notice", () => {
  const serverSource = readSource("lib", "server.js");

  it("starts the notice job with setImmediate from the gateway-ready hook and never awaits it", () => {
    const hook = serverSource.slice(serverSource.indexOf("  onGatewayReady: (payload) => {"), serverSource.indexOf("  runPostBootHook:"));
    expect(hook).toMatch(/setImmediate\(\(\) => \{\s+void toolInventory\.onGatewayReady\(\);\s+\}\);\s+return deployAnnouncer\.onGatewayReady\(payload\);/);
    expect(hook).not.toMatch(/await\s+toolInventory/);
    expect(hook.indexOf("reportDoctorFactsAfterServing")).toBeLessThan(hook.indexOf("toolInventory.onGatewayReady"));
  });

  it("reads the gateway's PATH, sends through the owner outbox and runs the skills check through execFileCmd", () => {
    const block = serverSource.slice(serverSource.indexOf("const toolInventory = createToolInventory({"), serverSource.indexOf("// Operator sidecars (ALPHACLAW_SIDECARS)"));
    expect(block).toContain("containerId: readContainerId(),");
    expect(block).toContain("getPathDirs: () => resolvePathDirs(gatewayEnv().PATH),");
    expect(block).toContain('execFileCmd("openclaw", ["skills", "check", "--json"], {');
    expect(block).toContain("timeout: kSkillsCheckTimeoutMs,");
    expect(block).toContain("notify: (message, opts) => upgradeNotifier.notify(message, opts),");
    expect(block).toContain(".tools?.ignoreMissing");
  });

  it("takes the shutdown snapshot first in the shutdown hook, feeds the Doctor card and the dismiss route", () => {
    expect(serverSource).toMatch(/onShutdownStart: \(\{ code, reason \}\) => \{\s+toolInventory\.recordSnapshot\(\{ reason: "shutdown" \}\);\s+writeShutdownRecord\(/);
    expect(serverSource).toContain("getToolInventory: () => toolInventory.getStatus(),");
    expect(serverSource).toMatch(/modelFailureWatch,\s+toolInventory,\s+resolveDoctorTimeoutMs,/);
    expect(readSource("lib", "server", "init", "register-server-routes.js")).toContain(
      "dismissToolsMissing: (containerId) => toolInventory?.dismissOutstanding(containerId),",
    );
  });
});
