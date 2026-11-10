const express = require("express");
const { wrapAsync } = require("../utils/wrap-async");
const { timingSafeStringEqual } = require("../utils/timing-safe");
const { sendPage, escapeHtml, isSameOriginRequest } = require("./secret-drop");
const { kConfirmTokenPattern } = require("../relay/confirmations");

// The owner's one-tap answer to a delegate's high-risk call (relay trust v2,
// GST-2090). AlphaClaw sends the owner a one-time link; the page behind it
// names the sender, lane, action and target, never the message text, and
// Approve or Deny is taken once, from a signed-in admin, same origin, with
// the page's CSRF value. Opening the page decides nothing.
//
//   GET  /relay/confirm/:token   the page (admin cookie session)
//   POST /relay/confirm/:token   decision=approve|deny (admin, same origin, CSRF)
const kBodyLimit = "4kb";

const registerRelayConfirmRoutes = ({ app, resolveRequestIdentity, confirmations, resolveSetupUrl, logger = console }) => {
  const baseUrl = () => String(resolveSetupUrl() || "").replace(/\/+$/, "");

  const sendGone = (res) =>
    sendPage(res, 410, {
      title: "Link expired",
      body: "<h1>This link expired or was already answered</h1><p>Confirmation links work once and last 15 minutes. Nothing was decided on this visit. If the agent still needs it, it asks again and you get a new link.</p>",
    });

  // Signed out: the login page, then back here. Signed in but not an admin:
  // refused. An agent's bearer is never a session.
  const gate = (req, res, { redirect }) => {
    const identity = resolveRequestIdentity(req);
    if (!identity) {
      if (redirect) {
        res.set("Cache-Control", "no-store");
        res.redirect(302, "/login.html?next=" + encodeURIComponent("/relay/confirm/" + req.params.token));
      } else {
        sendPage(res, 401, { title: "Sign in needed", body: "<h1>Sign in to AlphaClaw first</h1><p>Open the link again after you sign in. Nothing was decided.</p>" });
      }
      return null;
    }
    if (identity.role !== "admin") {
      sendPage(res, 403, { title: "Admin sign-in needed", body: "<h1>Only an AlphaClaw admin can answer this</h1><p>Sign in as an admin, then open the link again.</p>" });
      return null;
    }
    return identity;
  };

  const sendNotYours = (res, row) => {
    logger.warn("[relay] confirm refused id=" + row.id + ": not the owner of the sender's grant");
    return sendPage(res, 403, {
      title: "Owner sign-in needed",
      body: "<h1>Only the owner who connected @" + escapeHtml(row.sender) + " can answer this</h1><p>Sign in with the shared password, or as the admin who added this thread's delegate grant, then open the link again. Nothing was decided.</p>",
    });
  };

  const describe = (row) =>
    "<p><strong>@" + escapeHtml(row.sender) + "</strong>" + (row.lane ? " (lane <code>" + escapeHtml(row.lane) + "</code>)" : "") + ", a Capy thread you connected as a delegate, wants your agent to:</p>" +
    "<p><code>" + escapeHtml(row.action) + "</code></p>" +
    (row.target && row.target !== row.action ? "<p>Target: <code>" + escapeHtml(row.target) + "</code></p>" : "");

  app.get("/relay/confirm/:token", (req, res) => {
    if (!kConfirmTokenPattern.test(String(req.params.token || ""))) return sendGone(res);
    const identity = gate(req, res, { redirect: true });
    if (!identity) return undefined;
    const row = confirmations.resolveToken(req.params.token);
    if (!row) return sendGone(res);
    if (!confirmations.mayAnswer(row, identity)) return sendNotYours(res, row);
    const minutes = Math.max(1, Math.round((row.expiresAt - Date.now()) / 60000));
    return sendPage(res, 200, {
      title: "Confirm a relay request",
      body:
        "<h1>Confirm a change by your agent</h1>" +
        describe(row) +
        "<p>Approve lets the agent make exactly this change once, within 15 minutes, when the thread asks again. Deny tells the thread no. Anything else still needs its own confirmation.</p>" +
        '<form method="post" action="/relay/confirm/' + escapeHtml(req.params.token) + '">' +
        '<input type="hidden" name="csrf" value="' + escapeHtml(row.csrf) + '">' +
        '<button type="submit" name="decision" value="approve">Approve</button> ' +
        '<button type="submit" name="decision" value="deny" style="background:transparent;color:#f3f4f6;border-color:rgba(255,255,255,.3)">Deny</button>' +
        "</form>" +
        '<p class="muted">Confirmation ' + escapeHtml(row.id) + ". This link works once and expires in about " + minutes + " min.</p>",
    });
  });

  const bodyParser = express.urlencoded({ extended: false, limit: kBodyLimit, parameterLimit: 4 });

  app.post(
    "/relay/confirm/:token",
    bodyParser,
    wrapAsync(async (req, res) => {
      const token = String(req.params.token || "");
      if (!kConfirmTokenPattern.test(token)) return sendGone(res);
      const identity = gate(req, res, { redirect: false });
      if (!identity) return undefined;
      const row = confirmations.resolveToken(token);
      if (!row) return sendGone(res);
      if (!confirmations.mayAnswer(row, identity)) return sendNotYours(res, row);
      if (!isSameOriginRequest(req, baseUrl()) || !timingSafeStringEqual(String(req.body?.csrf || ""), String(row.csrf || ""))) {
        logger.warn("[relay] confirm refused id=" + row.id + ": " + (isSameOriginRequest(req, baseUrl()) ? "csrf mismatch" : "cross-origin post"));
        return sendPage(res, 403, { title: "Request refused", body: "<h1>This answer could not be verified</h1><p>Open the link again from the same browser. Nothing was decided.</p>" });
      }
      const decision = String(req.body?.decision || "");
      if (decision !== "approve" && decision !== "deny") {
        return sendPage(res, 400, { title: "Pick Approve or Deny", body: "<h1>Pick Approve or Deny</h1><p>Nothing was decided. Open the link again.</p>" });
      }
      const by = identity.kind === "member" ? "member:" + identity.memberId : "owner";
      const result = await confirmations.decide({ token, approve: decision === "approve", by });
      if (!result.ok) return sendGone(res);
      return sendPage(res, 200, {
        title: decision === "approve" ? "Approved" : "Denied",
        body:
          (decision === "approve"
            ? '<h1 class="ok">Approved</h1><p>@' + escapeHtml(row.sender) + " was told. Its next request for <code>" + escapeHtml(row.action) + "</code> is admitted once, within 15 minutes.</p>"
            : '<h1 class="error">Denied</h1><p>@' + escapeHtml(row.sender) + " was told no. Nothing was changed.</p>") +
          '<p class="muted">You can close this page.</p>',
      });
    }),
  );
};

module.exports = { registerRelayConfirmRoutes };
