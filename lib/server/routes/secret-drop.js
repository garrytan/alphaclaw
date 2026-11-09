const express = require("express");
const { wrapAsync } = require("../utils/wrap-async");
const { timingSafeStringEqual } = require("../utils/timing-safe");
const { kRequestContextHeader } = require("../agent-admin/constants");
const { kSecretDropTokenPattern } = require("../secret-drop/requests");

// The secret drop (GST-1956): the agent (or a person) asks for a named
// secret, AlphaClaw answers with a one-time link, and a signed-in admin types
// the value into the page behind it. The value goes to AlphaClaw's .env and
// OpenClaw's secret store (secret-drop/apply.js) and never into a chat, a
// transcript, a log line, a notice or any response.
//
//   POST /api/secrets/requests       { name, reason? } → one-time link
//   GET  /api/secrets/requests/:id   status, names only
//   GET  /secret/:token              the masked page (admin cookie session)
//   POST /secret/:token              Save (admin cookie, same origin, CSRF)
const kSecretDropBodyLimit = "64kb";
const kRequestIdPattern = /^sd_[a-f0-9]{18}$/;

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

const kPageStyle =
  "body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0d121b;color:#c9d1d9;display:flex;justify-content:center;padding:40px 16px;margin:0}" +
  "main{max-width:520px;width:100%;background:#0f141f;border:1px solid rgba(255,255,255,.11);border-radius:12px;padding:24px}" +
  "h1{font-size:18px;margin:0 0 12px;color:#f3f4f6}p,li{font-size:14px;line-height:1.5}code{background:rgba(0,0,0,.3);padding:1px 4px;border-radius:4px}" +
  "label{display:block;font-size:14px;margin:16px 0 6px}input[type=password],textarea{box-sizing:border-box;width:100%;font:inherit;padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#0d121b;color:#f3f4f6}" +
  "textarea{min-height:120px;-webkit-text-security:disc}details{margin-top:12px;font-size:13px}" +
  "button{font:inherit;margin-top:20px;padding:8px 16px;border-radius:8px;border:1px solid #63ebff;background:#63ebff;color:#0d121b;cursor:pointer}" +
  ".muted{color:#8b949e;font-size:12px}.error{color:#ff9b9b}.ok{color:#7ee787}";

const sendPage = (res, status, { title, body }) => {
  res.status(status);
  res.set("Cache-Control", "no-store");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res
    .type("html")
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
        "<title>" + escapeHtml(title) + "</title><style>" + kPageStyle + "</style></head><body><main>" + body + "</main></body></html>",
    );
};

const kReachSentences = {
  gateway_env: "The gateway gets it in its environment after its next restart (AlphaClaw never restarts it for this).",
  next_gateway_start: "The gateway sees it after its next start, when OpenClaw loads its .env.",
  never: "The gateway's own environment never gets it; scripts that read .env do.",
};

const describeStores = (stores) =>
  [stores?.env ? "AlphaClaw's .env" : null, stores?.store ? "OpenClaw's secret store" : null].filter(Boolean).join(" and ");

// Names, stores and where the key is usable. Never the value.
const describeOutcome = (name, { status, stores, reach }) => {
  const held = describeStores(stores) || "neither store";
  const lines = [status === "stored" ? `${name} is now in ${held}.` : `${name} is only in ${held}; the other store was not written.`];
  if (reach?.env) lines.push(kReachSentences[reach.env]);
  if (reach?.storeKind) {
    lines.push(
      reach.storeKind === "secret"
        ? `OpenClaw keeps it as a secret entry: a SecretRef { source: "store", id: "${name}" } can use it, and commands do not see it.`
        : `OpenClaw already had ${name} as an env entry and keeps it that way: commands OpenClaw runs get it, and its store listing shows a preview.`,
    );
  }
  return lines;
};

const registerSecretDropRoutes = ({
  app,
  requireAuth,
  resolveRequestIdentity,
  requests,
  applier,
  resolveSetupUrl,
  notify = null,
  logger = console,
}) => {
  const baseUrl = () => String(resolveSetupUrl() || "").replace(/\/+$/, "");

  app.post(
    "/api/secrets/requests",
    requireAuth,
    (req, res) => {
      const actor = req.alphaclawActor?.type === "agent" ? "agent" : resolveRequestIdentity(req)?.kind || "unknown";
      const created = requests.create({
        name: req.body?.name,
        reason: typeof req.body?.reason === "string" ? req.body.reason : "",
        requestedBy: actor,
        requestContext: req.headers?.[kRequestContextHeader] || null,
      });
      if (!created.ok) {
        logger.log(`[secret-drop] request refused code=${created.code} by=${actor}`);
        return res.status(created.code === "too_many_open" ? 429 : 400).json({ ok: false, code: created.code, error: created.error });
      }
      logger.log(`[secret-drop] request id=${created.request.id} name=${created.request.name} by=${actor}`);
      res.set("Cache-Control", "no-store");
      return res.status(201).json({
        ok: true,
        request: created.request,
        url: `${baseUrl()}/secret/${created.token}`,
        hint: "Send the link to the person. They open it signed in to AlphaClaw and paste the value there; it never goes in the chat. Read GET /api/secrets/requests/:id for the outcome.",
      });
    },
  );

  app.get("/api/secrets/requests/:id", requireAuth, (req, res) => {
    const id = String(req.params.id || "");
    const request = kRequestIdPattern.test(id) ? requests.get(id) : null;
    if (!request) return res.status(404).json({ ok: false, code: "not_found", error: "No such secret request (links last 15 minutes; a restart drops them)." });
    return res.json({ ok: true, request });
  });

  // Signed out: the login page, then back here. Signed in but not an admin:
  // refused. The agent's bearer is never a session, so it always lands here.
  const gate = (req, res, { redirect }) => {
    const identity = resolveRequestIdentity(req);
    if (!identity) {
      if (redirect) {
        res.set("Cache-Control", "no-store");
        res.redirect(302, `/login.html?next=${encodeURIComponent(`/secret/${req.params.token}`)}`);
      } else {
        sendPage(res, 401, { title: "Sign in needed", body: "<h1>Sign in to AlphaClaw first</h1><p>Open the link again after you sign in. Nothing was saved.</p>" });
      }
      return null;
    }
    if (identity.role !== "admin") {
      sendPage(res, 403, { title: "Admin sign-in needed", body: "<h1>Only an AlphaClaw admin can store secrets</h1><p>Sign in as an admin, then open the link again.</p>" });
      return null;
    }
    return identity;
  };

  const sendGone = (res) =>
    sendPage(res, 410, {
      title: "Link expired",
      body: "<h1>This link expired or was already used</h1><p>Links work once and last 15 minutes. This visit saved nothing. An earlier Save on this link saved something only if its page said Stored or Partly stored; otherwise ask for a new link (for example <code>/secret NAME</code> in Telegram).</p>",
    });

  const formBody = (request, { error = null, notices = [], retry = false } = {}) => {
    const minutes = Math.max(1, Math.round((request.expiresAt - Date.now()) / 60000));
    return (
      `<h1>${retry ? "Try again" : "Store"} <code>${escapeHtml(request.name)}</code></h1>` +
      (request.reason ? `<p>Requested for: ${escapeHtml(request.reason)}</p>` : "") +
      (error ? `<p class="error">${escapeHtml(error)}</p>` : "") +
      notices.map((notice) => `<p class="muted">${escapeHtml(notice)}</p>`).join("") +
      "<p>Paste the value and press Save. AlphaClaw writes it to its .env and to OpenClaw's secret store. It does not go into the chat, and the agent only learns that it was stored.</p>" +
      `<form method="post" action="/secret/${escapeHtml(request.token)}" autocomplete="off">` +
      `<input type="hidden" name="csrf" value="${escapeHtml(request.csrf)}">` +
      `<label for="value">Value of ${escapeHtml(request.name)}</label>` +
      '<input id="value" name="value" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" autofocus>' +
      "<details><summary>The value has several lines (a PEM key)</summary>" +
      '<label for="value_multiline">Multi-line value (saved to OpenClaw\'s secret store only; .env holds one line)</label>' +
      '<textarea id="value_multiline" name="value_multiline" autocomplete="off" spellcheck="false" autocapitalize="off"></textarea></details>' +
      '<button type="submit">Save</button></form>' +
      `<p class="muted">This link works once and expires in about ${minutes} min. The promise covers the hand-over: once stored, programs on this box that read .env (including commands the agent runs) can use the value.</p>`
    );
  };

  const bodyParser = express.urlencoded({ extended: false, limit: kSecretDropBodyLimit, parameterLimit: 8 });
  const parseDropBody = (req, res, next) =>
    bodyParser(req, res, (error) => {
      if (!error) return next();
      logger.warn(`[secret-drop] save body rejected: ${error.type || "unreadable"}`);
      return sendPage(res, error.type === "entity.too.large" ? 413 : 400, {
        title: "Could not read the value",
        body: "<h1>That value could not be read</h1><p>It may be too large (over 64 KiB once sent). Nothing was saved. Open the link again to retry.</p>",
      });
    });

  const saving = new Set();

  const isSameOrigin = (req) => {
    const origin = String(req.get("origin") || "");
    if (!origin || origin === "null") return String(req.get("sec-fetch-site") || "") === "same-origin";
    try {
      const url = new URL(origin);
      const configured = baseUrl() ? new URL(baseUrl()).origin : "";
      return url.origin === configured || url.host === String(req.get("host") || "");
    } catch {
      return false;
    }
  };

  app.get("/secret/:token", (req, res) => {
    if (!kSecretDropTokenPattern.test(String(req.params.token || ""))) return sendGone(res);
    if (!gate(req, res, { redirect: true })) return undefined;
    const request = requests.resolveToken(req.params.token);
    if (!request) return sendGone(res);
    return sendPage(res, 200, { title: `Store ${request.name}`, body: formBody({ ...request, token: req.params.token }) });
  });

  app.post(
    "/secret/:token",
    parseDropBody,
    wrapAsync(async (req, res) => {
      const token = String(req.params.token || "");
      if (!kSecretDropTokenPattern.test(token)) return sendGone(res);
      const identity = gate(req, res, { redirect: false });
      if (!identity) return undefined;
      const request = requests.resolveToken(token);
      if (!request) return sendGone(res);
      if (!isSameOrigin(req) || !timingSafeStringEqual(String(req.body?.csrf || ""), request.csrf)) {
        logger.warn(`[secret-drop] save refused id=${request.id}: ${isSameOrigin(req) ? "csrf mismatch" : "cross-origin post"}`);
        return sendPage(res, 403, { title: "Request refused", body: "<h1>This save could not be verified</h1><p>Open the link again from the same browser. Nothing was saved.</p>" });
      }
      const multiLine = typeof req.body?.value_multiline === "string" ? req.body.value_multiline : "";
      let rawValue = multiLine || (typeof req.body?.value === "string" ? req.body.value : "");
      req.body = undefined;
      if (saving.has(request.id)) {
        rawValue = null;
        logger.warn(`[secret-drop] save refused id=${request.id}: another save is running`);
        return sendPage(res, 409, {
          title: `Store ${request.name}`,
          body: "<h1>A save for this link is already running</h1><p>This press saved nothing. Wait for the first save to finish, then open the link again to see whether it needs a retry.</p>",
        });
      }
      saving.add(request.id);
      let result;
      try {
        result = await applier.apply({ req, name: request.name, rawValue });
      } catch (error) {
        logger.error(`[secret-drop] save failed id=${request.id}: ${error?.code || error?.name || "error"}`);
        result = { status: "failed", notices: ["The save failed unexpectedly. Nothing may have been written."] };
      } finally {
        rawValue = null;
        saving.delete(request.id);
      }
      const page = { ...request, token };
      if (result.status === "refused" || result.status === "failed") {
        logger.log(`[secret-drop] save ${result.status} id=${request.id} name=${request.name}${result.code ? ` code=${result.code}` : ""}`);
        return sendPage(res, result.status === "refused" ? 400 : 500, {
          title: `Store ${request.name}`,
          body: formBody(page, { error: result.error || "Nothing was saved.", notices: result.notices || [] }),
        });
      }
      const finished = requests.finish(request.id, result);
      const storesList = [result.stores.env ? "env" : null, result.stores.store ? "store" : null].filter(Boolean).join(",");
      logger.log(`[secret-drop] ${result.status} id=${request.id} name=${request.name} stores=${storesList} by=${identity.kind}`);
      const outcome = describeOutcome(request.name, result);
      Promise.resolve()
        .then(() =>
          notify?.(
            `🔑 *${result.status === "stored" ? "Secret stored" : "Secret partly stored"}*\n${outcome.join(" ")}${result.status === "partial" ? " The link stays open until it expires, for a retry." : ""}`,
            { eventType: "secret_drop", id: `secret-drop-${request.id}-${result.status}` },
          ),
        )
        .catch(() => {});
      const body =
        `<h1 class="${result.status === "stored" ? "ok" : "error"}">${result.status === "stored" ? "Stored" : "Partly stored"} <code>${escapeHtml(request.name)}</code></h1>` +
        outcome.map((line) => `<p>${escapeHtml(line)}</p>`).join("") +
        (result.notices || []).map((notice) => `<p class="muted">${escapeHtml(notice)}</p>`).join("") +
        (result.status === "partial"
          ? formBody(page, { retry: true })
          : "<p class=\"muted\">You can close this page. The agent sees that the secret was stored, never its value.</p>");
      return sendPage(res, 200, { title: finished?.status === "stored" ? `Stored ${request.name}` : `Partly stored ${request.name}`, body });
    }),
  );
};

module.exports = { registerSecretDropRoutes, describeOutcome };
