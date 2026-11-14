const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { GuestWriteError } = require("./constants");

// Picking up a member's file from their own scratch folder
// (<scratchRoot>/<member_slug>/tmp). The member owns that folder and can
// swap anything inside it at any moment, so nothing is trusted from a path
// check alone: the file is opened once with O_NOFOLLOW | O_NONBLOCK (a
// symlink fails, a FIFO never blocks), and every later check is on that
// open descriptor. It must be a regular file owned by the claim's uid with
// one link, the same inode the lstat saw, within the size cap, and the
// kernel's own path for the descriptor (/proc/self/fd) must lie inside the
// member's scratch folder, which rules out a swapped parent directory.
const refuse = (detail) => new GuestWriteError("guest_file_refused", detail);

const resolveScratchDir = ({ scratchRoot, memberSlug }) => path.join(scratchRoot, memberSlug, "tmp");

const readFdFully = (fd, size, fsModule) => {
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const read = fsModule.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return { buffer: buffer.subarray(0, offset), grew: offset > size };
};

const pickupScratchFile = ({ filePath, scratchRoot, memberSlug, memberUid, maxBytes, fsModule = fs, procFdDir = "/proc/self/fd" }) => {
  if (!scratchRoot) throw refuse("no_scratch_root");
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\u0000")) throw refuse("not_absolute");
  if (path.normalize(filePath) !== filePath || filePath.split("/").includes("..")) throw refuse("traversal");
  const scratchDir = resolveScratchDir({ scratchRoot, memberSlug });
  if (!filePath.startsWith(scratchDir + "/")) throw refuse("outside_scratch");
  let realScratch;
  try {
    realScratch = fsModule.realpathSync(scratchDir);
  } catch {
    throw refuse("no_scratch_dir");
  }
  let before;
  try {
    before = fsModule.lstatSync(filePath);
  } catch {
    throw refuse("missing");
  }
  if (!before.isFile()) throw refuse("not_regular");
  let fd;
  try {
    fd = fsModule.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    throw refuse("open_failed");
  }
  try {
    const stat = fsModule.fstatSync(fd);
    if (!stat.isFile()) throw refuse("not_regular");
    if (stat.uid !== memberUid) throw refuse("wrong_owner");
    if (stat.nlink !== 1) throw refuse("hardlink");
    if (stat.ino !== before.ino || stat.dev !== before.dev) throw refuse("swapped");
    if (stat.size > maxBytes) throw refuse("oversize");
    let real;
    try {
      real = fsModule.readlinkSync(path.join(procFdDir, String(fd)));
    } catch {
      throw refuse("no_fd_path");
    }
    if (!real.startsWith(realScratch + "/")) throw refuse("outside_scratch");
    const { buffer, grew } = readFdFully(fd, stat.size, fsModule);
    if (grew || buffer.length > maxBytes) throw refuse("oversize");
    return {
      buffer,
      name: path.basename(filePath),
      size: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  } finally {
    try {
      fsModule.closeSync(fd);
    } catch {}
  }
};

// The kept copy: <filesDir>/<group_slug>/<member_slug>/<sha256>-<safe name>,
// root, directories 0700, the file 0600 and never executable. Returns the
// path relative to filesDir.
const storeGuestFile = ({ filesDir, groupSlug, memberSlug, picked, fsModule = fs }) => {
  const safeName = picked.name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";
  const rel = path.join(groupSlug, memberSlug, picked.sha256 + "-" + safeName);
  const target = path.join(filesDir, rel);
  fsModule.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = target + ".tmp-" + crypto.randomBytes(6).toString("hex");
  fsModule.writeFileSync(temp, picked.buffer, { mode: 0o600, flag: "wx" });
  fsModule.renameSync(temp, target);
  return rel;
};

const removeGuestFile = ({ filesDir, rel, fsModule = fs }) => {
  const target = path.join(filesDir, rel);
  if (!target.startsWith(filesDir + "/")) return false;
  try {
    fsModule.unlinkSync(target);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
};

module.exports = { pickupScratchFile, storeGuestFile, removeGuestFile, resolveScratchDir };
