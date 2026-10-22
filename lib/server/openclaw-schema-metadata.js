// Public package metadata is authoritative. Invalid metadata is distinct
// from absence: neither legacy chunks nor remembered declarations may repair
// a malformed declaration on behalf of the executing build.

const parseSchemaMetadata = (raw) => {
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { status: "invalid" };
  }
  if (!pkg?.openclaw || !Object.hasOwn(pkg.openclaw, "schemaVersions")) return { status: "absent" };
  const value = pkg.openclaw.schemaVersions;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !["state", "agent"].every((kind) => Number.isSafeInteger(value[kind]) && value[kind] >= 0)) {
    return { status: "invalid" };
  }
  return { status: "valid", state: value.state, agent: value.agent };
};

const metadataDeclaration = (metadata) => metadata.status === "absent" ? null : ({
  state: metadata.status === "valid" ? metadata.state : null,
  agent: metadata.status === "valid" ? metadata.agent : null,
  files: ["package.json"],
  source: "declared",
  metadata: metadata.status,
  ...(metadata.status === "invalid" ? { unknownKinds: ["state", "agent"] } : {}),
});

module.exports = { parseSchemaMetadata, metadataDeclaration };
