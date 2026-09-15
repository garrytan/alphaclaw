const fs = require("fs");

// A successful kill only delivers a signal. A closed leader may still have
// live grandchildren in its owned group. Linux zombies cannot write and must
// not pin cleanup forever while the container's init is slow to reap them.
const processGroupHasWriters = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, 0); } catch (error) {
    return error.code !== "ESRCH";
  }
  if (process.platform !== "linux") return true;
  let entries;
  try { entries = fs.readdirSync("/proc"); } catch { return true; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8"); } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") continue;
      return true; // Unknown process identity is not proof of termination.
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return true;
  }
  return false;
};

module.exports = { processGroupHasWriters };
