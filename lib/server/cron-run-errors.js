const kUnavailableCode = "cron_history_unavailable";

class CronHistoryUnavailableError extends Error {
  constructor(cause) {
    super("Cron history is temporarily unavailable. Retry after OpenClaw finishes updating or restores access to its history storage.", { cause });
    this.code = kUnavailableCode;
  }
}

module.exports = { CronHistoryUnavailableError, kUnavailableCode };
