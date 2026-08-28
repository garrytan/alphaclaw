const startServerLifecycle = ({
  server,
  PORT,
  isOnboarded,
  runOnboardedBootSequence,
}) => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[alphaclaw] Express listening on :${PORT}`);
    if (isOnboarded()) {
      // Fire-and-forget: the server answers requests while boot runs in the
      // background; boot progress is surfaced via boot-phase in the status
      // snapshot (the sequence reports its own failures there too).
      Promise.resolve(runOnboardedBootSequence()).catch((error) => {
        console.error(
          `[alphaclaw] Boot sequence error: ${error?.message || error}`,
        );
      });
    } else {
      console.log("[alphaclaw] Awaiting onboarding via Setup UI");
    }
  });
};

const registerServerShutdown = ({ gmailWatchService, watchdogTerminal }) => {
  const shutdownGmailWatchService = async () => {
    try {
      await gmailWatchService.stop();
    } catch {}
    watchdogTerminal.disposeSession();
  };

  process.on("SIGTERM", () => {
    shutdownGmailWatchService();
  });
  process.on("SIGINT", () => {
    shutdownGmailWatchService();
  });
};

module.exports = {
  startServerLifecycle,
  registerServerShutdown,
};
