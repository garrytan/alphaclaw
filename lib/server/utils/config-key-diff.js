// Key-paths-only diff of two plain-object config trees.
//
//   diffConfigKeyPaths(a, b) → { added, removed, changed }
//
// `added` lists dotted key paths present in `b` but not `a`, `removed` the
// reverse, `changed` paths present in both whose leaf values differ. Objects
// recurse; arrays, primitives, null and non-plain objects are LEAVES compared
// by JSON text, so an array edit reports its parent once (`agents.list`),
// never `agents.list.2`. A subtree that appears or disappears is reported
// once, at its root. A type change (object ↔ scalar) is a `changed` leaf. An
// input that is not a plain object (null, array, scalar) diffs as an empty
// tree — so `diff(null, null)` is empty and `diff(cfg, null)` reports every
// top-level key of `cfg` as removed. Each array is sorted, so two runs over the
// same pair are byte-identical.
//
// Why this exists next to doctor-guard.js, which is "deliberately NOT a
// generic config-diff engine": that note protects one invariant — openclaw.json
// carries secrets, and nothing derived from it may reach a notification, the
// ledger or a log line. A semantic differ would have to emit VALUES to be
// useful and would break it. This module never does: the result holds key
// paths and (through the array lengths) counts only, the same identifiers
// doctor-guard's own inventory already logs, so callers may persist and print
// it freely (the config gate's pre-restore diff, doctor-guard's pre/post-fix
// counts). It is a path enumerator, not a semantic differ: no type coercion,
// no ordering tolerance, no schema knowledge. Keys containing "." are joined
// verbatim (the doctor-guard collectEnvRefPaths convention) — the output is
// for humans and counts, not for re-addressing the tree.

// Recursion stops here and the remaining subtree compares as one leaf, so a
// hostile or cyclic tree can never blow the stack. Real openclaw.json trees
// are a handful of levels deep.
const kMaxDepth = 32;

const isPlainObject = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// Leaves compare by JSON text: arrays element-wise in order, objects past the
// depth cap structurally. A value JSON cannot serialize (cycle, BigInt) falls
// back to identity so the differ never throws on a hostile tree.
const leafEqual = (left, right) => {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const walk = (left, right, prefix, depth, out) => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const inLeft = Object.hasOwn(left, key);
    const inRight = Object.hasOwn(right, key);
    if (!inLeft) {
      out.added.push(keyPath);
      continue;
    }
    if (!inRight) {
      out.removed.push(keyPath);
      continue;
    }
    const leftValue = left[key];
    const rightValue = right[key];
    if (
      depth < kMaxDepth &&
      isPlainObject(leftValue) &&
      isPlainObject(rightValue)
    ) {
      walk(leftValue, rightValue, keyPath, depth + 1, out);
    } else if (!leafEqual(leftValue, rightValue)) {
      out.changed.push(keyPath);
    }
  }
};

const diffConfigKeyPaths = (a, b) => {
  const out = { added: [], removed: [], changed: [] };
  walk(isPlainObject(a) ? a : {}, isPlainObject(b) ? b : {}, "", 0, out);
  // Default (code-unit) sort: locale-independent, so the persisted diff is
  // identical on every host.
  out.added.sort();
  out.removed.sort();
  out.changed.sort();
  return out;
};

module.exports = {
  diffConfigKeyPaths,
};
