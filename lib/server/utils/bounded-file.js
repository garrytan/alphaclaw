const fs = require("node:fs");

const readRegularFileBounded = (file, { fsModule = fs, maxBytes = 1024 * 1024, encoding = "utf8" } = {}) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("Invalid regular-file read limit");
  const refuse = (code, message) => { throw Object.assign(new Error(message), { code, path: file }); };
  const fd = fsModule.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fsModule.fstatSync(fd);
    if (!before.isFile()) refuse("REGULAR_FILE_REQUIRED", "Expected a regular file");
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) refuse("FILE_READ_LIMIT", "Regular file exceeds the read limit");
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fsModule.readSync(fd, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count > maxBytes) refuse("FILE_READ_LIMIT", "Regular file exceeds the read limit");
    const after = fsModule.fstatSync(fd);
    const named = fsModule.lstatSync(file);
    if (count !== before.size || !after.isFile() || !named.isFile() ||
        ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => before[key] !== after[key] || before[key] !== named[key])) {
      refuse("FILE_IDENTITY_CHANGED", "Regular file changed during the read");
    }
    const data = buffer.subarray(0, count);
    return encoding === null ? data : data.toString(encoding);
  } finally { fsModule.closeSync(fd); }
};

module.exports = { readRegularFileBounded };
