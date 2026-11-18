// A launch's re-apply of the pinned OpenClaw package (GST-3061): the start's
// own apply, run out of the server process (openclaw-package-override.js
// defaultRunReapply). Arguments: <installDir> <managedDir> <openclawDir>. The
// apply never throws and records its verdict, which the parent reads.
const { applyOpenclawPackageAtBoot } = require("./openclaw-package-override");

const [installDir, managedDir, openclawDir] = process.argv.slice(2);
if (!installDir || !managedDir || !openclawDir) {
  console.error("[alphaclaw] openclaw package re-apply: usage: <installDir> <managedDir> <openclawDir>");
  process.exit(2);
}
applyOpenclawPackageAtBoot({ installDir, managedDir, openclawDir });
