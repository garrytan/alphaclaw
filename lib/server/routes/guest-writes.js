const { wrapAsync } = require("../utils/wrap-async");
const { describeGuestError, GuestWriteError } = require("../guest-writes");

// Guest notes (GST-2662, docs/designs/guest-notes.md).
//
// Internal routes, used only on the box itself and answered like no route
// otherwise: the caller must come from loopback with no proxy headers and
// carry the guest-writes internal secret (guest-writes/internal-secret,
// 0600 root) as the bearer.
//   POST /internal/guest-writes/claim  the guard records who a member's
//                                      guest_save call is for;
//   POST /internal/guest-writes/save   the guest_save MCP server's save.
//
// Setup API:
//   GET  /api/guest-notes                      status and per-group settings;
//   PUT  /api/guest-notes/groups/:groupKey     turn a group on or off (humans
//                                              only; on waits for the brain's
//                                              guest_marker_v1 capability).
// A note the owner keeps is promoted in gbrain, which marks the guest page;
// the broker reads that mark and skips it at retention.
const kLoopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const internalCaller = (req, guestWrites) => {
  const bearer = /^Bearer (.+)$/.exec(String(req.get("authorization") || ""))?.[1] || "";
  const proxied = Boolean(req.get("x-forwarded-for") || req.get("forwarded") || req.get("x-real-ip"));
  return kLoopbackAddresses.has(String(req.socket?.remoteAddress || "")) && !proxied && guestWrites.isInternalSecret(bearer);
};

const registerGuestWritesRoutes = ({ app, requireAuth, guestWrites, log = console.log }) => {
  app.post("/internal/guest-writes/claim", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!internalCaller(req, guestWrites)) return res.status(404).end();
    try {
      const result = guestWrites.claim(req.body);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      log("[alphaclaw] guest-notes: claim failed: " + (error?.code || error?.message || "error"));
      return res.status(503).json({ ok: false, code: "claim_unavailable" });
    }
  });

  app.post(
    "/internal/guest-writes/save",
    wrapAsync(async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (!internalCaller(req, guestWrites)) return res.status(404).end();
      try {
        return res.json({ ok: true, ...(await guestWrites.save(req.body)) });
      } catch (error) {
        if (!(error instanceof GuestWriteError)) log("[alphaclaw] guest-notes: save failed: " + (error?.code || error?.message || "error"));
        const { code } = describeGuestError(error);
        return res.json({ ok: false, code });
      }
    }),
  );

  app.get(
    "/api/guest-notes",
    requireAuth,
    wrapAsync(async (req, res) => {
      res.set("Cache-Control", "no-store");
      return res.json({ ok: true, ...(await guestWrites.status()) });
    }),
  );

  app.put(
    "/api/guest-notes/groups/:groupKey",
    requireAuth,
    wrapAsync(async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (req.alphaclawActor?.type === "agent") return res.status(403).json({ ok: false, code: "humans_only", error: "Only a signed-in person can turn guest notes on or off." });
      try {
        const group = await guestWrites.setGroup({ groupKey: String(req.params.groupKey || ""), enabled: req.body?.enabled });
        return res.json({ ok: true, groupKey: req.params.groupKey, group });
      } catch (error) {
        if (error instanceof GuestWriteError && error.code === "invalid_input") return res.status(400).json({ ok: false, code: "invalid_input", error: "Send { enabled: true|false } for a known group key." });
        if (error instanceof GuestWriteError && error.code === "guest_saves_unavailable") return res.status(409).json({ ok: false, code: "guest_saves_unavailable", error: "The brain doesn't support guest notes yet, so they can't be turned on." });
        log("[alphaclaw] guest-notes: setting failed: " + (error?.code || error?.message || "error"));
        return res.status(500).json({ ok: false, code: "save_failed", error: "The setting could not be saved." });
      }
    }),
  );
};

module.exports = { registerGuestWritesRoutes, internalCaller };
