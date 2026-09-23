class OfflineCopyError extends Error {
  constructor(stage, message, { cause = null } = {}) {
    super(message);
    this.name = "OfflineCopyError";
    this.stage = stage;
    if (cause) this.cause = cause;
    if ([11, 26].includes(Number(cause?.errcode) & 0xff) || /SQLITE_(CORRUPT|NOTADB)/.test(String(cause?.code || ""))) {
      this.sourceCorrupt = true;
      this.code = "SQLITE_CORRUPT";
    }
  }
}

module.exports = { OfflineCopyError };
