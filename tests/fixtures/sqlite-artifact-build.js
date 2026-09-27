const fs = require("fs");
const path = require("path");
const evidence = require("./sqlite-artifact-producers.json");
const installed = path.resolve(__dirname, "../../node_modules/openclaw");
const pinnedBuild = { packageDir: installed, version: evidence.version, buildId: evidence.version, source: "installed" };
const copyPinnedBuild = (directory, source = "installed") => {
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(path.join(installed, "package.json"), path.join(directory, "package.json"));
  for (const relative of Object.keys(evidence.files)) {
    fs.mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
    fs.copyFileSync(path.join(installed, relative), path.join(directory, relative));
  }
  return { ...pinnedBuild, packageDir: directory, source };
};
module.exports = { pinnedBuild, copyPinnedBuild, evidence };
