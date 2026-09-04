const { sanitizeLabel } = require("./sanitize-label");

// One structured, injection-safe audit line per rejected identifier at the API
// boundary (fix wave PR 1). Traversal shapes in agentId / channel / client /
// accountId used to be silently 400'd or, worse, reach path.join — now every
// rejection names the route, the field, the reason and the ACTOR (the agent
// bearer vs a human session) so an incidents review can see who probed what.
// The value is sanitized (control chars stripped, length-capped) and never a
// secret: only identifiers go through here.
const describeActor = (req) => {
  if (req?.alphaclawActor?.type) return req.alphaclawActor.type;
  if (req?.alphaclawIdentity) return "human";
  return "unknown";
};

const logRejectedInput = ({ req, field, reason, value }) => {
  const route = `${String(req?.method || "").toUpperCase()} ${String(req?.path || req?.url || "")}`;
  console.warn(
    `[input] rejected ${sanitizeLabel(route, { maxLength: 96 })} field=${field} reason=${reason} actor=${describeActor(req)} value=${JSON.stringify(
      sanitizeLabel(value, { maxLength: 80 }),
    )}`,
  );
};

module.exports = { logRejectedInput, describeActor };
