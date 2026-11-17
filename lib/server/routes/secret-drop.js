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
//   GET  /secret/:token              the page (admin cookie session): a shell
//                                    for the Setup UI's secret-drop bundle
//   GET  /secret/:token/status       the link's state for the page (JSON)
//   POST /secret/:token              Save (admin cookie, same origin, CSRF),
//                                    answered in JSON
//
// One link saves once. A second press while a save runs waits for that save
// and gets its answer, writing nothing of its own; a press on a stored link
// gets the stored state back. Reopening a used link shows what its save did.
const kSecretDropBodyLimit = "64kb";
const kRequestIdPattern = /^sd_[a-f0-9]{18}$/;
const kPageCsp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

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

// A form post from this AlphaClaw's own page: the Origin is the configured
// setup URL or this request's host; a browser that sends no Origin must say
// same-origin in Sec-Fetch-Site. Shared with routes/relay-confirm.js.
const isSameOriginRequest = (req, base) => {
  const origin = String(req.get("origin") || "");
  if (!origin || origin === "null") return String(req.get("sec-fetch-site") || "") === "same-origin";
  try {
    const url = new URL(origin);
    const configured = base ? new URL(base).origin : "";
    return url.origin === configured || url.host === String(req.get("host") || "");
  } catch {
    return false;
  }
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
    if (!request) return res.status(404).json({ ok: false, code: "not_found", error: "No such secret request (links last 15 minutes; a used or expired one stays readable for a day)." });
    return res.json({ ok: true, request });
  });

  // Signed out: the login page, then back here. Signed in but not an admin:
  // refused. The agent's bearer is never a session, so it always lands here.
  const gatePage = (req, res) => {
    const identity = resolveRequestIdentity(req);
    if (!identity) {
      res.set("Cache-Control", "no-store");
      res.redirect(302, `/login.html?next=${encodeURIComponent(`/secret/${req.params.token}`)}`);
      return null;
    }
    if (identity.role !== "admin") {
      sendPage(res, 403, { title: "Admin sign-in needed", body: "<h1>Only an AlphaClaw admin can store secrets</h1><p>Sign in as an admin, then open the link again.</p>" });
      return null;
    }
    return identity;
  };

  const sendJson = (res, status, body) => {
    res.set("Cache-Control", "no-store");
    return res.status(status).json(body);
  };

  const gateJson = (req, res) => {
    const identity = resolveRequestIdentity(req);
    if (!identity) {
      sendJson(res, 401, { ok: false, code: "signed_out", error: "You are signed out of AlphaClaw, so nothing was saved. Sign in again, then press Retry." });
      return null;
    }
    if (identity.role !== "admin") {
      sendJson(res, 403, { ok: false, code: "not_admin", error: "Only an AlphaClaw admin can store secrets. Nothing was saved." });
      return null;
    }
    return identity;
  };

  const sendGone = (res, { neverSaved = false } = {}) =>
    sendPage(res, 410, {
      title: "Link expired",
      body: neverSaved
        ? "<h1>This link has expired</h1><p>Nothing was saved with it. Links work for 15 minutes; ask for a new one (for example <code>/secret NAME</code> in Telegram).</p>"
        : "<h1>This link has expired</h1><p>Links work for 15 minutes, and a used link shows what it saved for a day after. Nothing was saved on this visit; ask for a new link if you still need one (for example <code>/secret NAME</code> in Telegram).</p>",
    });

  const kGone = { ok: false, code: "gone", error: "This link has expired. Nothing was saved; ask for a new link (for example /secret NAME in Telegram)." };

  // What the page shows: names, status, where the key is usable and the
  // CSRF value while the link can still save. Never a value.
  const pageView = (record) => ({
    ...requests.view(record),
    reason: record.reason || "",
    ...(record.stores ? { outcome: describeOutcome(record.name, record) } : {}),
    ...(requests.isOpen(record) ? { csrf: record.csrf } : {}),
  });

  const sendShell = (res, request) => {
    res.status(200);
    res.set("Cache-Control", "no-store");
    res.set("X-Frame-Options", "DENY");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Content-Security-Policy", kPageCsp);
    res
      .type("html")
      .send(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
          `<title>Store ${escapeHtml(request.name)}</title>` +
          '<link rel="icon" type="image/svg+xml" href="/img/logo.svg"><link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/css/tailwind.generated.css">' +
          '<script src="/js/theme-prepaint.js"></script></head>' +
          '<body class="min-h-screen flex justify-center px-4 py-10"><div id="app" class="max-w-md w-full"></div>' +
          '<script type="module" src="/dist/secret-drop.bundle.js"></script></body></html>',
      );
  };

  const bodyParser = express.urlencoded({ extended: false, limit: kSecretDropBodyLimit, parameterLimit: 8 });
  const parseDropBody = (req, res, next) =>
    bodyParser(req, res, (error) => {
      if (!error) return next();
      logger.warn(`[secret-drop] save body rejected: ${error.type || "unreadable"}`);
      const tooLarge = error.type === "entity.too.large";
      return sendJson(res, tooLarge ? 413 : 400, {
        ok: false,
        code: tooLarge ? "too_large" : "unreadable",
        error: tooLarge ? "The value is too large (over 64 KiB once sent). Nothing was saved." : "The value could not be read. Nothing was saved.",
      });
    });

  // id → the running save's answer, which a second press of the same link
  // waits for and gets instead of saving again.
  const saving = new Map();

  const isSameOrigin = (req) => isSameOriginRequest(req, baseUrl());

  app.get("/secret/:token", (req, res) => {
    if (!kSecretDropTokenPattern.test(String(req.params.token || ""))) return sendGone(res);
    if (!gatePage(req, res)) return undefined;
    const record = requests.lookupToken(req.params.token);
    if (!record) return sendGone(res);
    if (record.status === "expired" && !record.interrupted) return sendGone(res, { neverSaved: true });
    return sendShell(res, record);
  });

  app.get("/secret/:token/status", (req, res) => {
    if (!kSecretDropTokenPattern.test(String(req.params.token || ""))) return sendJson(res, 410, kGone);
    if (!gateJson(req, res)) return undefined;
    const record = requests.lookupToken(req.params.token);
    if (!record) return sendJson(res, 410, kGone);
    return sendJson(res, 200, { ok: true, link: pageView(record) });
  });

  // The save's answer; it never throws, so a press waiting on it gets the same.
  const runSave = async ({ req, record, identity, rawValue }) => {
    let result;
    try {
      result = await applier.apply({ req, name: record.name, rawValue });
    } catch (error) {
      logger.error(`[secret-drop] save failed id=${record.id}: ${error?.code || error?.name || "error"}`);
      result = { status: "failed", error: "The save failed unexpectedly. Saving again is safe: it replaces whatever was written." };
    } finally {
      rawValue = null;
    }
    if (result.status === "refused" || result.status === "failed") {
      logger.log(`[secret-drop] save ${result.status} id=${record.id} name=${record.name}${result.code ? ` code=${result.code}` : ""}`);
      return {
        httpStatus: result.status === "refused" ? 400 : 500,
        body: { ok: false, code: result.code || result.status, error: result.error || "Nothing was saved.", notices: result.notices || [], link: pageView(record) },
      };
    }
    requests.finish(record.id, result);
    const storesList = [result.stores.env ? "env" : null, result.stores.store ? "store" : null].filter(Boolean).join(",");
    logger.log(`[secret-drop] ${result.status} id=${record.id} name=${record.name} stores=${storesList} by=${identity.kind}`);
    const outcome = describeOutcome(record.name, result);
    Promise.resolve()
      .then(() =>
        notify?.(
          `🔑 *${result.status === "stored" ? "Secret stored" : "Secret partly stored"}*\n${outcome.join(" ")}${result.status === "partial" ? " The link stays open until it expires, for a retry." : ""}`,
          { eventType: "secret_drop", id: `secret-drop-${record.id}-${result.status}` },
        ),
      )
      .catch(() => {});
    return { httpStatus: 200, body: { ok: true, link: pageView(record) } };
  };

  app.post(
    "/secret/:token",
    parseDropBody,
    wrapAsync(async (req, res) => {
      const token = String(req.params.token || "");
      if (!kSecretDropTokenPattern.test(token)) return sendJson(res, 410, kGone);
      const identity = gateJson(req, res);
      if (!identity) return undefined;
      const record = requests.lookupToken(token);
      if (!record) return sendJson(res, 410, kGone);
      if (!isSameOrigin(req) || !timingSafeStringEqual(String(req.body?.csrf || ""), record.csrf)) {
        logger.warn(`[secret-drop] save refused id=${record.id}: ${isSameOrigin(req) ? "csrf mismatch" : "cross-origin post"}`);
        return sendJson(res, 403, { ok: false, code: "unverified", error: "This save could not be verified, so nothing was saved. Press Retry." });
      }
      const multiLine = typeof req.body?.value_multiline === "string" ? req.body.value_multiline : "";
      let rawValue = multiLine || (typeof req.body?.value === "string" ? req.body.value : "");
      req.body = undefined;
      const running = saving.get(record.id);
      if (running) {
        rawValue = null;
        logger.log(`[secret-drop] save joined id=${record.id}: a save of this link is running`);
        const joined = await running;
        return sendJson(res, joined.httpStatus, joined.body);
      }
      if (!requests.isOpen(record)) {
        rawValue = null;
        if (record.status !== "stored") return sendJson(res, 410, { ...kGone, link: pageView(record) });
        logger.log(`[secret-drop] save skipped id=${record.id}: already stored`);
        return sendJson(res, 200, { ok: true, link: pageView(record) });
      }
      if (!requests.beginSave(record.id)) {
        rawValue = null;
        requests.endSave(record.id);
        logger.error(`[secret-drop] save refused id=${record.id}: the links file cannot be written or removed`);
        return sendJson(res, 503, {
          ok: false,
          code: "state_unwritable",
          error: "AlphaClaw cannot record this save on its disk, so it saved nothing. Press Retry; if it keeps failing, AlphaClaw's data folder is not writable.",
          link: pageView(record),
        });
      }
      const run = runSave({ req, record, identity, rawValue });
      rawValue = null;
      saving.set(record.id, run);
      try {
        const answer = await run;
        return sendJson(res, answer.httpStatus, answer.body);
      } finally {
        saving.delete(record.id);
        requests.endSave(record.id);
      }
    }),
  );
};

module.exports = { registerSecretDropRoutes, describeOutcome, sendPage, escapeHtml, isSameOriginRequest };
