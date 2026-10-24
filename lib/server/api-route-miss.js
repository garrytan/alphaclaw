const { SETUP_API_PREFIXES } = require("./constants");
const { isLocalApiPath, kApiCatchAllPathPattern } = require("./routes/proxy");

// Unknown-route answers for AUTHENTICATED /api callers. Every caller runs
// after requireAuth, so an unauthenticated request never reaches this module
// and keeps its 401 whether or not the route exists (no route enumeration).
//
// classifyApiRequest asks Express's own route table (Express 4 app._router)
// whether a real route serves this method and path:
//   route              a local route matches method and path
//   method_not_allowed the path is routed, but only for other methods
//   not_found          a local namespace with no route for the path
//   gateway            outside every local namespace: the catch-all forwards
//                      it to the gateway, so AlphaClaw cannot say it is unknown
//                      (bare /api and /api/ never reach the catch-all, so they
//                      are classified like a local path)
// The proxy catch-all route itself is skipped: it matches every /api path.
const classifyApiRequest = (req) => {
  const fullPath = `${req.baseUrl || ""}${req.path || ""}`;
  if (kApiCatchAllPathPattern.test(fullPath) && !isLocalApiPath(fullPath, SETUP_API_PREFIXES)) {
    return { kind: "gateway" };
  }
  const methods = new Set();
  for (const layer of req.app?._router?.stack || []) {
    const route = layer.route;
    if (!route || route.path === kApiCatchAllPathPattern) continue;
    if (!layer.regexp.test(fullPath)) continue;
    if (route.methods._all) return { kind: "route" };
    for (const method of Object.keys(route.methods)) methods.add(method.toUpperCase());
  }
  if (methods.size === 0) return { kind: "not_found" };
  if (methods.has("GET")) methods.add("HEAD");
  const method = String(req.method || "GET").toUpperCase();
  if (methods.has(method) || method === "OPTIONS") {
    return { kind: "route" };
  }
  return { kind: "method_not_allowed", allow: [...methods].sort() };
};

// The answer for a not_found / method_not_allowed verdict as
// { status, body, allow }, or null for a verdict the caller answers itself.
const describeApiRouteMiss = (verdict) => {
  if (verdict.kind === "not_found") {
    return {
      status: 404,
      body: {
        ok: false,
        error: "No such API route",
        code: "route_not_found",
        hint: "Check the method and path. Agents: run `alphaclaw admin manifest` for the operation catalog.",
      },
    };
  }
  if (verdict.kind === "method_not_allowed") {
    return {
      status: 405,
      allow: verdict.allow.join(", "),
      body: {
        ok: false,
        error: `This route accepts ${verdict.allow.join(", ")}`,
        code: "method_not_allowed",
        allow: verdict.allow,
      },
    };
  }
  return null;
};

// Sends the miss answer for this request; false when a real route matches
// (or the path is the gateway's) and the caller keeps its own answer.
const sendApiRouteMiss = (req, res) => {
  const miss = describeApiRouteMiss(classifyApiRequest(req));
  if (!miss) return false;
  if (miss.allow) res.set("Allow", miss.allow);
  res.status(miss.status).json(miss.body);
  return true;
};

// Terminal /api handler, mounted after every route and express.static: only
// unmatched requests in a local namespace get here (the catch-all forwards
// the rest to the gateway). A matched route that fell through, and OPTIONS,
// go on to Express's own final handler as before.
const apiRouteMissHandler = (req, res, next) => {
  if (sendApiRouteMiss(req, res)) return;
  next();
};

module.exports = {
  apiRouteMissHandler,
  classifyApiRequest,
  describeApiRouteMiss,
  sendApiRouteMiss,
};
