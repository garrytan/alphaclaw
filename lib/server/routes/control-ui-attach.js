const { wrapAsync } = require("../utils/wrap-async");
const {
  kControlUiAttachPath,
  kAttachRequestHeader,
  renderAttachPage,
  resolveAttachTarget,
  setAttachMarkerCookie,
} = require("../control-ui-attach");

// GET  /gateway/attach?to=/openclaw/...  page that seeds the Control UI tab
// POST /gateway/attach                   the gateway token for that page
// See lib/server/control-ui-attach.js for the flow. Deliberately NOT under
// /api, like /gateway/launch: the agent bearer is only ever admitted inside
// /api, so the agent actor cannot reach either route, and a signed-out
// browser gets the login redirect for the page and a 401 for the POST.
const registerControlUiAttachRoutes = ({
  app,
  requireAuth,
  isAuthorizedRequest,
  isAdminRequest,
  isOnboarded,
  dashboardUrlService,
}) => {
  app.get(kControlUiAttachPath, requireAuth, (req, res) => {
    const target = resolveAttachTarget(String(req.query.to || ""));
    res.set("Cache-Control", "no-store");
    if (!isOnboarded() || !isAdminRequest(req)) {
      setAttachMarkerCookie(req, res);
      res.set("Location", target);
      return res.status(302).end();
    }
    res.type("html").send(renderAttachPage(target));
  });

  app.post(
    kControlUiAttachPath,
    wrapAsync(async (req, res) => {
      res.set("Cache-Control", "no-store");
      if (!isAuthorizedRequest(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      // A cross-site page can make a credentialed POST but cannot add a
      // custom header without a CORS preflight, which this route never grants.
      if (
        req.headers[kAttachRequestHeader] !== "1" ||
        String(req.headers["sec-fetch-site"] || "same-origin") !== "same-origin"
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }
      // The pass for the attach page's own return navigation. It reaches the
      // browser with this answer, after the token read: a pass handed out
      // with the page itself would let any other tab opened during a slow
      // read through without a token. Set before anything can fail, so
      // whatever this answers, the return navigation goes through.
      setAttachMarkerCookie(req, res);
      if (!isOnboarded() || !isAdminRequest(req)) {
        return res.json({ token: "" });
      }
      let token = "";
      try {
        token = (await dashboardUrlService.resolveDashboardToken())?.token || "";
      } catch {
        token = "";
      }
      console.log(`[alphaclaw] control ui attach: outcome=${token ? "token" : "tokenless"}`);
      return res.json({ token });
    }),
  );
};

module.exports = { registerControlUiAttachRoutes };
