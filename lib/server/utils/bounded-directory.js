const fs = require("node:fs");

const readDirectoryNamesBounded = (directory, { fsModule = fs, maxEntries = 4096 } = {}) => {
  const handle = fsModule.opendirSync(directory);
  const names = [];
  try {
    for (let entry; (entry = handle.readSync());) {
      if (names.length >= maxEntries) {
        throw Object.assign(new Error("Directory entry limit exceeded"), { code: "DIRECTORY_ENTRY_LIMIT" });
      }
      names.push(entry.name);
    }
    return names;
  } finally {
    handle.closeSync();
  }
};

module.exports = { readDirectoryNamesBounded };
