const express = require("express");
const { wrapAsync } = require("../utils/wrap-async");
const { escapeHtml, isSameOriginRequest, kPageStyle, kReachSentences } = require("./secret-drop");
const { kCallbackPath, kClientIdEnvKey, kClientSecretEnvKey } = require("../slack-oauth");

// The "Connect Slack" page (slack-oauth/index.js). Every route here is for a
// person signed in to AlphaClaw as an admin. The agent's bearer is never a
// session, so it gets the sign-in page or a refusal, never a flow.
//
//   GET  /slack/connect           the page: connected workspaces and Connect
//   POST /slack/connect           start (same origin, CSRF) → Slack's consent page
//   GET  /slack/oauth/callback    Slack's answer → token stored → back to the page
const kConnectPath = "/slack/connect";
const kConnectedPattern = /^SLACK_USER_TOKEN_[A-Z0-9_]{1,64}$/;

const kErrorSentences = {
  not_configured: "Slack isn't set up on this box yet: " + kClientIdEnvKey + " and " + kClientSecretEnvKey + " are missing from its environment.",
  unverified: "AlphaClaw couldn't verify that press, so nothing started. Reload this page and press Connect again.",
  bad_state: "That Slack sign-in was already used or didn't come from this page. Press Connect again.",
  expired_state: "That Slack sign-in took longer than 10 minutes. Press Connect again.",
  other_session: "That Slack sign-in started in a different AlphaClaw session. Press Connect again here.",
  denied: "Slack says you pressed Cancel, so nothing was connected.",
  extra_scopes: "Slack granted more than read access, so AlphaClaw refused the token and handed it back to Slack. Nothing was connected.",
  no_user_token: "Slack didn't return a user token, so nothing was connected. Press Connect again.",
  lookup_failed: "Slack didn't say which workspace that was, so AlphaClaw handed the token back. Nothing was connected. Press Connect again.",
  exchange_failed: "AlphaClaw couldn't reach Slack to finish, so nothing was connected. Press Connect again.",
  exchange_refused: "Slack refused to finish the sign-in, so nothing was connected. Press Connect again.",
  slack_error: "Slack returned an error, so nothing was connected. Press Connect again.",
  no_code: "Slack's answer was incomplete, so nothing was connected. Press Connect again.",
  unnamed_workspace: "AlphaClaw couldn't tell which workspace that was, so it handed the token back. Nothing was connected.",
  store_failed: "AlphaClaw couldn't save the token, so nothing was connected. Press Connect again.",
  name_taken: "Another workspace is already saved under that workspace's name, so AlphaClaw handed the token back. Nothing was connected.",
};

const kSlackPageStyle =
  kPageStyle +
  "ul.ws{list-style:none;padding:0;margin:16px 0 0}ul.ws li{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid rgba(255,255,255,.08)}" +
  ".notice{margin-top:16px;padding:10px 12px;border-radius:8px;font-size:14px;background:rgba(255,255,255,.04)}";

const formatUtc = (iso) => {
  const text = String(iso || "");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? text.slice(0, 10) + " " + text.slice(11, 16) + " UTC" : "";
};

const sessionCookieOf = (req) => {
  for (const part of String(req.headers?.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === "setup_token") return rest.join("=");
  }
  return "";
};

const sendSlackPage = (res, status, body) => {
  res.status(status);
  res.set("Cache-Control", "no-store");
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://slack.com https://*.slack.com",
  );
  res
    .type("html")
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
        "<title>Connect Slack</title><style>" + kSlackPageStyle + "</style></head><body><main>" + body + "</main></body></html>",
    );
};

const sendRefusal = (res, status, heading, sentence) =>
  sendSlackPage(res, status, "<h1>" + escapeHtml(heading) + "</h1><p>" + escapeHtml(sentence) + "</p>");

const registerSlackConnectRoutes = ({ app, resolveRequestIdentity, slackOauth, resolveSetupUrl, logger = console }) => {
  const baseUrl = (req) => String(resolveSetupUrl() || "").replace(/\/+$/, "") || req.protocol + "://" + String(req.get("host") || "");
  const redirectUri = (req) => baseUrl(req) + kCallbackPath;
  const formParser = express.urlencoded({ extended: false, limit: "4kb", parameterLimit: 4 });

  // A person's admin session, never the agent: requireAuth marks a bearer
  // caller as the agent actor, and resolveRequestIdentity reads cookies only.
  const adminOf = (req) => {
    if (req.alphaclawActor?.type === "agent") return null;
    const identity = resolveRequestIdentity(req);
    return identity?.role === "admin" ? identity : null;
  };

  const renderPage = (req, res) => {
    const installs = [...slackOauth.listInstalls()].sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)));
    const connected = String(req.query?.connected || "");
    const errorCode = String(req.query?.error || "");
    let notice = "";
    if (kConnectedPattern.test(connected)) {
      const row = installs.find((install) => install.envKey === connected);
      const name = row?.teamName || row?.domain || "The workspace";
      const sentences =
        row?.status === "partial"
          ? [name + " is connected, but its token is saved only in " + (row.stores?.env ? "AlphaClaw's .env" : "OpenClaw's secret store") + ". Press Connect again to save it in both."]
          : [name + " is connected. Its token is saved as " + connected + "."];
      if (row?.reachEnv && kReachSentences[row.reachEnv]) sentences.push(kReachSentences[row.reachEnv]);
      notice = '<p class="notice ' + (row?.status === "partial" ? "error" : "ok") + '">' + escapeHtml(sentences.join(" ")) + "</p>";
    } else if (kErrorSentences[errorCode]) {
      notice = '<p class="notice error">' + escapeHtml(kErrorSentences[errorCode]) + "</p>";
    }
    const list = installs.length
      ? '<ul class="ws">' +
        installs
          .map((install) => "<li><span>" + escapeHtml(install.teamName || install.domain || install.teamId) + '</span><span class="muted">' + escapeHtml(formatUtc(install.installedAt)) + "</span></li>")
          .join("") +
        "</ul>"
      : '<p class="muted">No workspaces connected yet.</p>';
    const action = slackOauth.isConfigured()
      ? '<form method="post" action="' + kConnectPath + '"><input type="hidden" name="csrf" value="' + escapeHtml(slackOauth.csrfFor(sessionCookieOf(req))) + '"><button type="submit">Connect a workspace</button></form>'
      : '<p class="notice error">' + escapeHtml(kErrorSentences.not_configured) + "</p>";
    return sendSlackPage(
      res,
      200,
      "<h1>Connect Slack</h1>" +
        "<p>Lets the box's Slack scripts read a workspace as you: search, channels, direct messages and people. It can't post, react or change anything.</p>" +
        "<p>Press Connect, choose the workspace on Slack's page, then press Allow. You come back here when it's done.</p>" +
        notice +
        list +
        action,
    );
  };

  app.get(kConnectPath, (req, res) => {
    if (req.alphaclawActor?.type !== "agent" && !resolveRequestIdentity(req)) {
      res.set("Cache-Control", "no-store");
      return res.redirect(302, "/login.html?next=" + encodeURIComponent(kConnectPath));
    }
    if (!adminOf(req)) return sendRefusal(res, 403, "Admin sign-in needed", "Only an AlphaClaw admin can connect Slack. Sign in as an admin, then open this page again.");
    return renderPage(req, res);
  });

  app.post(kConnectPath, formParser, (req, res) => {
    if (!adminOf(req)) return sendRefusal(res, 403, "Admin sign-in needed", "Only an AlphaClaw admin can connect Slack. Sign in as an admin, then open this page again.");
    const sessionCookie = sessionCookieOf(req);
    if (!isSameOriginRequest(req, baseUrl(req)) || !slackOauth.checkCsrf(sessionCookie, req.body?.csrf)) {
      logger.warn("[slack-oauth] connect refused: " + (isSameOriginRequest(req, baseUrl(req)) ? "csrf mismatch" : "cross-origin post"));
      return sendRefusal(res, 403, "Not verified", kErrorSentences.unverified);
    }
    const started = slackOauth.start({ sessionCookie, redirectUri: redirectUri(req) });
    res.set("Cache-Control", "no-store");
    if (!started.ok) return res.redirect(303, kConnectPath + "?error=" + encodeURIComponent(started.code === "not_configured" ? "not_configured" : "unverified"));
    return res.redirect(303, started.url);
  });

  app.get(
    kCallbackPath,
    wrapAsync(async (req, res) => {
      res.set("Referrer-Policy", "no-referrer");
      if (!adminOf(req)) {
        logger.warn("[slack-oauth] callback refused: not an admin session");
        return sendRefusal(res, 403, "Admin sign-in needed", "Slack sent you back, but this browser isn't signed in to AlphaClaw as an admin, so nothing was connected. Sign in, then press Connect again.");
      }
      const query = req.query || {};
      const pick = (value) => (typeof value === "string" ? value : "");
      const outcome = await slackOauth.finish({
        req,
        state: pick(query.state),
        code: pick(query.code),
        error: pick(query.error),
        sessionCookie: sessionCookieOf(req),
        redirectUri: redirectUri(req),
      });
      res.set("Cache-Control", "no-store");
      return res.redirect(
        303,
        outcome.ok ? kConnectPath + "?connected=" + encodeURIComponent(outcome.install.envKey) : kConnectPath + "?error=" + encodeURIComponent(outcome.code),
      );
    }),
  );
};

module.exports = { registerSlackConnectRoutes, kConnectPath };
