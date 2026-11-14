const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pickupScratchFile, storeGuestFile, removeGuestFile } = require("../../lib/server/guest-writes/files");

const kMember = "mfedcba9876543210";
const uid = process.getuid();
let root;
let scratch;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "guest-files-"));
  scratch = path.join(root, "m", kMember, "tmp");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const pick = (filePath, overrides = {}) =>
  pickupScratchFile({ filePath, scratchRoot: path.join(root, "m"), memberSlug: kMember, memberUid: uid, maxBytes: 1024, ...overrides });

const refusedFor = (fn) => {
  try {
    fn();
  } catch (error) {
    return [error.code, error.detail];
  }
  return null;
};

describe("guest file pickup", () => {
  it("reads a plain file the member owns", () => {
    const file = path.join(scratch, "notes.txt");
    fs.writeFileSync(file, "hello");
    expect(pick(file)).toMatchObject({ name: "notes.txt", size: 5, buffer: Buffer.from("hello") });
  });

  it("refuses a symlink, a hardlink, a FIFO, traversal, another folder, the wrong owner and oversize", () => {
    const outside = path.join(root, "secret.txt");
    fs.writeFileSync(outside, "secret");
    fs.symlinkSync(outside, path.join(scratch, "link.txt"));
    expect(refusedFor(() => pick(path.join(scratch, "link.txt")))).toEqual(["guest_file_refused", "not_regular"]);

    const hard = path.join(scratch, "hard.txt");
    fs.linkSync(outside, hard);
    expect(refusedFor(() => pick(hard))).toEqual(["guest_file_refused", "hardlink"]);

    const fifo = path.join(scratch, "pipe");
    execFileSync("mkfifo", [fifo]);
    expect(refusedFor(() => pick(fifo))).toEqual(["guest_file_refused", "not_regular"]);

    expect(refusedFor(() => pick(scratch + "/../../../secret.txt"))[0]).toBe("guest_file_refused");
    expect(refusedFor(() => pick(outside))).toEqual(["guest_file_refused", "outside_scratch"]);
    expect(refusedFor(() => pick("relative.txt"))).toEqual(["guest_file_refused", "not_absolute"]);

    const mine = path.join(scratch, "mine.txt");
    fs.writeFileSync(mine, "x");
    expect(refusedFor(() => pick(mine, { memberUid: uid + 1 }))).toEqual(["guest_file_refused", "wrong_owner"]);

    const big = path.join(scratch, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(2048));
    expect(refusedFor(() => pick(big))).toEqual(["guest_file_refused", "oversize"]);
  });

  it("refuses a scratch folder swapped for a symlink to somewhere else", () => {
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "f.txt"), "x");
    fs.rmSync(scratch, { recursive: true });
    fs.symlinkSync(elsewhere, scratch);
    fs.mkdirSync(path.join(root, "m", kMember, "real"), { recursive: true });
    expect(pick(path.join(scratch, "f.txt")).size).toBe(1);
    const sub = path.join(scratch, "sub");
    fs.symlinkSync(root, sub);
    expect(refusedFor(() => pick(path.join(sub, "secret.txt")))).toBeTruthy();
  });

  it("keeps a copy at 0600 under 0700 folders and removes it", () => {
    const filesDir = path.join(root, "guest-files");
    const rel = storeGuestFile({ filesDir, groupSlug: "g0123456789abcdef", memberSlug: kMember, picked: { name: ".hidden a b.txt", buffer: Buffer.from("x"), sha256: "ab".repeat(32) } });
    const target = path.join(filesDir, rel);
    expect(rel.startsWith("g0123456789abcdef/" + kMember + "/")).toBe(true);
    expect(path.basename(target)).toBe("ab".repeat(32) + "-hidden_a_b.txt");
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
    expect(removeGuestFile({ filesDir, rel })).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });
});
