// One line per Google call in <root>/google-workspace/audit-<UTC day>.jsonl
// (dir 0700, files 0600): time, product, tool, the choices Google offered,
// the choice given and the outcome. Never arguments, content, the account
// address or a token. Files older than 30 days are deleted at start and
// daily. Never throws.
const fs = require("fs");
const path = require("path");

const kDirName = "google-workspace";
const kRetentionDays = 30;
const kFilePattern = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const kDayMs = 24 * 60 * 60 * 1000;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const createAudit = ({ rootDir, fsModule = fs, now = Date.now, logger = null } = {}) => {
  const dir = path.join(String(rootDir || ""), kDirName);
  let warned = false;
  const warn = (what, error) => {
    if (warned) return;
    warned = true;
    logger?.warn?.("[google-workspace] audit " + what + " failed: " + String(error?.code || error?.message || error).slice(0, 80));
  };

  const write = ({ product, tool, outcome, offered = null, given = null, requestId = null }) => {
    if (!rootDir) return;
    try {
      fsModule.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const at = now();
      const line = {
        at: new Date(at).toISOString(),
        product: String(product || "").slice(0, 32),
        tool: String(tool || "").slice(0, 64),
        outcome: String(outcome || "").slice(0, 48),
        ...(Array.isArray(offered) ? { offered: offered.map((choice) => String(choice).slice(0, 40)).slice(0, 10) } : {}),
        ...(given ? { given: String(given).slice(0, 40) } : {}),
        ...(requestId ? { request: String(requestId).slice(0, 80) } : {}),
      };
      fsModule.appendFileSync(path.join(dir, "audit-" + dayOf(at) + ".jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch (error) {
      warn("write", error);
    }
  };

  const prune = () => {
    let removed = 0;
    try {
      if (!fsModule.existsSync(dir)) return 0;
      const cutoff = dayOf(now() - kRetentionDays * kDayMs);
      for (const name of fsModule.readdirSync(dir)) {
        const match = kFilePattern.exec(name);
        if (!match || match[1] >= cutoff) continue;
        fsModule.rmSync(path.join(dir, name), { force: true });
        removed += 1;
      }
    } catch (error) {
      warn("prune", error);
    }
    return removed;
  };

  return { write, prune, dir };
};

module.exports = { createAudit, kRetentionDays, kDirName };
