// Renamed model ids of AlphaClaw's provider presets (presets.js
// `renamedModelIds`), carried into openclaw.json at boot.
//
// The gateway's config.patch (which `openclaw config set` goes through while
// a gateway runs) rewrites every models.providers catalog row id through its
// provider plugin's modelIdNormalization policy, but never the agent refs
// that name the row (src/config/model-input-normalization.ts, 2026.11.3 and
// 2026.11.4). OpenClaw's Particle plugin (@openclaw/particle-provider,
// installed on request) aliases particle-1 to particle-ai/particle-1, so on a
// box with it installed the first such write after AlphaClaw wrote a
// particle-1 row renamed the row and left every particle/particle-1 ref as it
// was: the ensure then took the block for an operator edit, and the model
// check found no particle-1 row.
//
// Two steps per renamed id, both idempotent:
// 1. A block whose owned keys are still exactly what AlphaClaw wrote under the
//    old id gets that row renamed, so it matches the preset again.
// 2. A block that then has the new row and not the old one gets every old ref
//    rewritten to the new ref, in each place OpenClaw reads one, for the
//    defaults and each agent (the config module presents agents.entries as
//    agents.list). This step reads only the row ids, so a
//    block the operator edited keeps its edits and loses only the dangling
//    ref. A block with both rows, or only the old one, is left as it is.
// modelPolicy.allow entries move at the next gateway launch instead
// (renameModelPolicyRefs in model-policy.js, from renamedOwnedModelRefs),
// because a modelPolicy hot reload revokes in-flight session work.
const { isDeepStrictEqual } = require("node:util");
const { isNonArrayObject } = require("../utils/object");
const { kOwnedProviderPresets } = require("./presets");

const kSelectionKeys = ["model", "imageModel", "voiceModel", "pdfModel"];
const kMediaKeys = ["image", "video", "music"];

const dedupe = (refs) => [...new Set(refs)];

const renameSelection = (value, rename) => {
  if (typeof value === "string") return rename(value);
  if (!isNonArrayObject(value)) return value;
  const next = { ...value };
  if (typeof value.primary === "string") next.primary = rename(value.primary);
  if (Array.isArray(value.fallbacks)) next.fallbacks = dedupe(value.fallbacks.map((ref) => (typeof ref === "string" ? rename(ref) : ref)));
  return next;
};

const renameModelsMap = (models, oldRef, newRef) => {
  if (!Object.hasOwn(models, oldRef)) return models;
  const oldRow = models[oldRef];
  const next = {};
  for (const [ref, row] of Object.entries(models)) {
    if (ref === newRef) continue;
    if (ref !== oldRef) {
      next[ref] = row;
      continue;
    }
    const newRow = models[newRef];
    if (!Object.hasOwn(models, newRef)) next[newRef] = oldRow;
    else if (isNonArrayObject(oldRow) && isNonArrayObject(newRow)) {
      next[newRef] = { ...oldRow, ...newRow };
      if (isNonArrayObject(oldRow.params) && isNonArrayObject(newRow.params)) next[newRef].params = { ...oldRow.params, ...newRow.params };
    } else next[newRef] = newRow;
  }
  return next;
};

// Rewrites oldRef in one agent scope in place; returns how many places changed.
const renameRefsInScope = (scope, oldRef, newRef) => {
  if (!isNonArrayObject(scope)) return 0;
  let count = 0;
  const rename = (ref) => {
    if (ref !== oldRef) return ref;
    count += 1;
    return newRef;
  };
  const setIfChanged = (holder, key, next) => {
    if (!isDeepStrictEqual(holder[key], next)) holder[key] = next;
  };
  for (const key of kSelectionKeys) {
    if (Object.hasOwn(scope, key)) setIfChanged(scope, key, renameSelection(scope[key], rename));
  }
  if (typeof scope.utilityModel === "string") scope.utilityModel = rename(scope.utilityModel);
  if (isNonArrayObject(scope.mediaModels)) {
    for (const key of kMediaKeys) {
      if (Object.hasOwn(scope.mediaModels, key)) setIfChanged(scope.mediaModels, key, renameSelection(scope.mediaModels[key], rename));
    }
  }
  if (typeof scope.heartbeat?.model === "string") scope.heartbeat.model = rename(scope.heartbeat.model);
  if (isNonArrayObject(scope.subagents) && Object.hasOwn(scope.subagents, "model")) {
    setIfChanged(scope.subagents, "model", renameSelection(scope.subagents.model, rename));
  }
  if (typeof scope.compaction?.model === "string") scope.compaction.model = rename(scope.compaction.model);
  if (typeof scope.compaction?.memoryFlush?.model === "string") scope.compaction.memoryFlush.model = rename(scope.compaction.memoryFlush.model);
  if (isNonArrayObject(scope.models) && Object.hasOwn(scope.models, oldRef)) {
    scope.models = renameModelsMap(scope.models, oldRef, newRef);
    count += 1;
  }
  return count;
};

const renameRefs = (config, oldRef, newRef) => {
  const agents = config?.agents;
  if (!isNonArrayObject(agents)) return 0;
  let count = renameRefsInScope(agents.defaults, oldRef, newRef);
  for (const agent of Array.isArray(agents.list) ? agents.list : []) count += renameRefsInScope(agent, oldRef, newRef);
  return count;
};

const blockMatchesOldPreset = (block, preset, oldId, newId) => {
  const rows = block.models;
  if (block.baseUrl !== preset.baseUrl || block.api !== preset.api || block.apiKey !== `\${${preset.envVar}}`) return false;
  return preset.models.every((model) => {
    const expected = model.id === newId ? { ...model, id: oldId } : model;
    return rows.some((row) => isDeepStrictEqual(row, expected));
  });
};

const rowIdsOf = (config, preset) => {
  const block = config?.models?.providers?.[preset.id];
  if (!isNonArrayObject(block) || !Array.isArray(block.models)) return null;
  return new Set(block.models.map((row) => row?.id));
};

// Read only: the { oldRef, newRef } pairs whose refs should move, because the
// block has the new row and not the old one.
const renamedOwnedModelRefs = (config, { presets = kOwnedProviderPresets } = {}) => {
  const pairs = [];
  for (const preset of presets) {
    const ids = rowIdsOf(config, preset);
    if (!ids) continue;
    for (const [oldId, newId] of Object.entries(preset.renamedModelIds || {})) {
      if (ids.has(newId) && !ids.has(oldId)) pairs.push({ oldRef: `${preset.id}/${oldId}`, newRef: `${preset.id}/${newId}` });
    }
  }
  return pairs;
};

// In-memory, at boot: returns one entry per renamed id it acted on.
const migrateRenamedOwnedModels = (config, { presets = kOwnedProviderPresets } = {}) => {
  const applied = [];
  for (const preset of presets) {
    for (const [oldId, newId] of Object.entries(preset.renamedModelIds || {})) {
      const ids = rowIdsOf(config, preset);
      if (!ids) continue;
      const block = config.models.providers[preset.id];
      const rowRenamed = ids.has(oldId) && !ids.has(newId) && blockMatchesOldPreset(block, preset, oldId, newId);
      if (rowRenamed) block.models = block.models.map((row) => (row?.id === oldId ? { ...row, id: newId } : row));
      if (!rowRenamed && (ids.has(oldId) || !ids.has(newId))) continue;
      const refs = renameRefs(config, `${preset.id}/${oldId}`, `${preset.id}/${newId}`);
      if (rowRenamed || refs) applied.push({ provider: preset.id, from: oldId, to: newId, rowRenamed, refs });
    }
  }
  return applied;
};

module.exports = { migrateRenamedOwnedModels, renamedOwnedModelRefs };
