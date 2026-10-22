// `alphaclaw doctor finding complete --id --run --token`, the callback a
// Doctor fix run uses to mark its finding fixed. bin/alphaclaw.js dispatches
// here after the .env load.

const createDoctorFindingCommands = ({ commandArgs, flagValue, rootDir }) => {
  const runDoctorFindingComplete = () => {
    const cardId = Number.parseInt(
      String(flagValue(commandArgs, "--id") || ""),
      10,
    );
    const runId = String(flagValue(commandArgs, "--run") || "").trim();
    const token = String(flagValue(commandArgs, "--token") || "").trim();
    if (!Number.isInteger(cardId) || cardId <= 0 || !runId || !token) {
      console.error(
        "[alphaclaw] doctor finding complete requires --id, --run, and --token",
      );
      return 1;
    }

    const {
      closeDoctorDb,
      completeDoctorCardFix,
      initDoctorDb,
    } = require("../server/db/doctor");
    const {
      hashDoctorFixToken,
    } = require("../server/doctor/fix-completion");
    try {
      initDoctorDb({ rootDir, markInterruptedRuns: false });
      const card = completeDoctorCardFix({
        id: cardId,
        runId,
        tokenHash: hashDoctorFixToken(token),
      });
      if (!card) {
        console.error("[alphaclaw] Doctor fix completion was not accepted");
        return 1;
      }
      console.log(`[alphaclaw] Doctor finding ${cardId} marked fixed`);
      return 0;
    } catch (error) {
      console.error(
        `[alphaclaw] Doctor fix completion failed: ${error.message || "Unknown error"}`,
      );
      return 1;
    } finally {
      closeDoctorDb();
    }
  };

  return { runDoctorFindingComplete };
};

module.exports = { createDoctorFindingCommands };
