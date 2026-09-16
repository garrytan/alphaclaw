// A real producer process for the pinned upstream backup race regression.
// Faster sampling makes atomic publication and exit cleanup overlap a short
// archive run without changing production's thirty-second cadence.
const { startGatewayMemorySampler } = require("../../lib/server/gateway-memory/telemetry-sampler");

const sampler = startGatewayMemorySampler({
  stateDir: process.argv[2],
  setIntervalImpl: (callback) => setInterval(callback, 5),
});
if (!sampler) throw new Error("telemetry sampler unavailable");
sampler.flush().then(() => process.stdout.write("ready\n"));
setTimeout(async () => {
  await sampler.flush();
  process.stdout.write(`samples:${sampler.getRecords().length}\n`);
  // The sampler's actual exit listener unlinks its owned publication.
  process.exit(0);
}, 500);
