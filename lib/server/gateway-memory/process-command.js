const fs = require("node:fs");
const path = require("node:path");

// The child's command for the owner's container alert (ALPH-17): the basename
// of its executable, else the kernel's short name (/proc/<pid>/comm; Node
// renames its main thread "MainThread", so the executable comes first). Never
// argv or a full path, which can carry tokens, and never into events, the API
// or a prompt. A name outside a plain token charset is withheld, not escaped.
const kCommandPattern = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,31}$/;
const plainName = (value) => kCommandPattern.test(value) ? value : null;
const readProcessCommand = (pid, fsModule = fs) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const name = plainName(path.basename(String(fsModule.readlinkSync(`/proc/${pid}/exe`))));
    if (name) return name;
  } catch {}
  try {
    return plainName(String(fsModule.readFileSync(`/proc/${pid}/comm`, "utf8")).trim());
  } catch {
    return null;
  }
};

module.exports = { readProcessCommand };
