const { findOp, resolveTier } = require("../admin-manifest");
const { applyOpRedaction, summarizeParams } = require("./redact");
const {
  kConfirmHeader,
  kRequestContextHeader,
  kMaxRequestContextLength,
} = require("./constants");

// Tier enforcement + response redaction + audit for the AGENT actor only.
// Human cookie sessions never enter this code path, so flag-on changes
// nothing for the web UI. Mounted on /api immediately after requireAuth.
const createAgentAdminEnforcement = ({
  resolveRequestActor,
  insertWatchdogEvent = null,
  confirmService = null,
  notifyAdmins = null,
}) => {
  const audit = ({ req, op, tier, phase, status, httpStatus, extra = {} }) => {
    try {
      insertWatchdogEvent?.({
        eventType: "agent_admin",
        source: "agent-admin",
        status,
        details: {
          op: op?.id || null,
          method: req.method,
          path: req.baseUrl + req.path,
          tier: tier || null,
          phase,
          actor: "agent",
          ...(httpStatus ? { httpStatus } : {}),
          ...(req.headers?.[kRequestContextHeader]
            ? {
                requestContext: String(req.headers[kRequestContextHeader]).slice(
                  0,
                  kMaxRequestContextLength,
                ),
              }
            : {}),
          paramsSummary: summarizeParams(req.body),
          ...extra,
        },
      });
    } catch {
      // Audit failures never block the mutation; the insert helper logs.
    }
  };

  const deny = ({ req, res, op, tier, status, body }) => {
    audit({
      req,
      op,
      tier,
      phase: "denied",
      status: "warning",
      httpStatus: status,
      extra: { code: body.code },
    });
    return res.status(status).json(body);
  };

  // Outcome capture hooks res "finish"/"close" — not a res.json wrap — so
  // send/204/streams/thrown handlers/reset connections all record (A26).
  const attachOutcomeAudit = ({ req, res, op, tier }) => {
    let recorded = false;
    const record = (closedEarly) => {
      if (recorded) return;
      recorded = true;
      audit({
        req,
        op,
        tier,
        phase: "outcome",
        status: res.statusCode < 400 ? "info" : "failed",
        httpStatus: res.statusCode,
        ...(closedEarly ? { extra: { connectionClosedEarly: true } } : {}),
      });
    };
    res.once("finish", () => record(false));
    res.once("close", () => record(true));
  };

  const attachRedaction = ({ res, op }) => {
    if (op.streaming) return; // SSE writes via res.write; never wrap
    const originalJson = res.json.bind(res);
    res.json = (body) => originalJson(applyOpRedaction(op, body));
  };

  return (req, res, next) => {
    const actor = resolveRequestActor(req);
    if (!actor || actor.type !== "agent") return next();

    const fullPath = req.baseUrl + req.path; // Express trims the mount (A19)
    const op = findOp(req.method, fullPath);

    // Deny-by-default across the WHOLE /api surface, GETs included: an
    // unmatched path would otherwise fall through to the gateway catch-all
    // proxy, which trusts proxied requests in trusted-proxy mode (A20).
    if (!op) {
      return deny({
        req,
        res,
        op: null,
        tier: null,
        status: 403,
        body: {
          ok: false,
          error: "Operation not in the admin manifest",
          code: "op_not_in_manifest",
          hint: "Run `alphaclaw admin manifest` for the operation catalog — your skill copy may be stale.",
        },
      });
    }

    const tier = resolveTier(op, req);

    if (tier === "denied") {
      return deny({
        req,
        res,
        op,
        tier,
        status: 403,
        body: {
          ok: false,
          error: `Operation ${op.id} is not available to the agent`,
          code: "denied",
          ...(op.hint ? { hint: op.hint } : {}),
        },
      });
    }

    if (tier === "dangerous") {
      if (!confirmService) {
        return deny({
          req,
          res,
          op,
          tier,
          status: 403,
          body: {
            ok: false,
            error: `Operation ${op.id} requires operator confirmation`,
            code: "dangerous_op_requires_confirmation",
            hint: "This operation is dashboard-only until the confirm flow ships; ask an operator to run it in the Setup UI.",
          },
        });
      }
      const confirmCode = req.headers?.[kConfirmHeader];
      const outcome = confirmService.gate({ req, op, confirmCode });
      if (!outcome.ok) {
        audit({
          req,
          op,
          tier,
          phase: outcome.phase || "denied",
          status: "warning",
          httpStatus: outcome.status,
          extra: {
            code: outcome.body?.code,
            ...(outcome.confirmId ? { confirmId: outcome.confirmId } : {}),
          },
        });
        if (outcome.retryAfterSec) {
          res.set("Retry-After", String(outcome.retryAfterSec));
        }
        return res.status(outcome.status).json(outcome.body);
      }
      audit({
        req,
        op,
        tier,
        phase: "intent",
        status: "info",
        extra: { confirmId: outcome.confirmId },
      });
      attachOutcomeAudit({ req, res, op, tier });
      attachRedaction({ res, op });
      if (typeof notifyAdmins === "function") {
        res.once("finish", () => {
          if (res.statusCode < 400) {
            notifyAdmins({ op, req, tier });
          }
        });
      }
      return next();
    }

    if (tier === "restart") {
      // Durable INTENT row before the handler runs: restart-tier ops can
      // kill the process before "finish" ever fires (A9/A26).
      audit({ req, op, tier, phase: "intent", status: "info" });
      attachOutcomeAudit({ req, res, op, tier });
      attachRedaction({ res, op });
      if (typeof notifyAdmins === "function") {
        res.once("finish", () => {
          if (res.statusCode < 400) {
            notifyAdmins({ op, req, tier });
          }
        });
      }
      return next();
    }

    // safe + write tiers: audit outcomes for mutations, redact reads too.
    if (req.method !== "GET") {
      attachOutcomeAudit({ req, res, op, tier });
    }
    attachRedaction({ res, op });
    return next();
  };
};

module.exports = { createAgentAdminEnforcement, kRequestContextHeader, kConfirmHeader };
