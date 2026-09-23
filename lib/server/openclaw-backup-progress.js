const path = require("path");

const createBackupProgress = ({ root, outputFile, fsModule = require("fs"), maxEntries = 400 }) => {
  const rootIdentity = fsModule.lstatSync(root);
  const files = new Map();
  const identities = new Map();
  let doneBytes = 0;
  let verify = false;
  const ownsRoot = () => {
    try {
      const current = fsModule.lstatSync(root);
      return current.isDirectory() && current.dev === rootIdentity.dev && current.ino === rootIdentity.ino &&
        current.birthtimeMs === rootIdentity.birthtimeMs;
    } catch { return false; }
  };
  const sample = () => {
    if (!ownsRoot()) return { doneBytes, stage: verify ? "verify" : "write" };
    let visited = 0;
    const observe = (file, stat) => {
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let prior = files.get(file);
      if (!prior) {
        const archive = file === outputFile || path.basename(file) === "archive.tar.gz.tmp" ||
          (file.startsWith(`${outputFile}.`) && file.endsWith(".tmp"));
        if (files.size >= maxEntries - (archive ? 0 : 2)) return;
        prior = { identity, replaced: false };
        files.set(file, prior);
      }
      if (identity !== prior.identity) prior.replaced = true;
      if (prior.replaced) return;
      const highWater = identities.get(identity) ?? 0;
      if (stat.size > highWater) {
        doneBytes += stat.size - highWater;
        identities.set(identity, stat.size);
      }
      if (file === outputFile && stat.size > 0) verify = true;
    };
    try {
      const final = fsModule.lstatSync(outputFile);
      if (final.isFile()) observe(outputFile, final);
    } catch {}
    const walk = (dir, depth = 0) => {
      if (depth > 4 || visited >= maxEntries) return;
      let entries;
      try { entries = fsModule.opendirSync(dir); } catch { return; }
      try {
        let entry;
        const children = [];
        while (visited < maxEntries && (entry = entries.readSync())) {
          visited++;
          const file = path.join(dir, entry.name);
          let stat;
          try { stat = fsModule.lstatSync(file); } catch { continue; }
          if (stat.isDirectory()) { children.push(file); continue; }
          if (!stat.isFile()) continue;
          observe(file, stat);
        }
        children.sort((a, b) => Number(path.basename(b).startsWith(".openclaw-backup-publish-")) -
          Number(path.basename(a).startsWith(".openclaw-backup-publish-")));
        for (const child of children) walk(child, depth + 1);
      } finally { entries.closeSync(); }
    };
    walk(root);
    return { doneBytes, stage: verify ? "verify" : "write" };
  };
  return { ownsRoot, sample, probe: () => {
    const value = sample();
    return { bytes: value.doneBytes, phase: value.stage };
  } };
};

module.exports = { createBackupProgress };
