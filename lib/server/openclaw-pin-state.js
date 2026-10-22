// The pin boundary, as one answer for the status payload and the Doctor card.
// AlphaClaw runs the OpenClaw its package.json pins; an installed tree with a
// different version (or one whose version cannot be read) means the image did
// not install the pin, so the operator sees it instead of finding it only in
// diagnose output. Input: openclawRuntime.getInfo().
//   match       installed === pinned
//   diverged    both readable, different
//   unreadable  the pin is declared but the installed version is missing or
//               unparseable (no node_modules/openclaw, a torn package.json)
//   unknown     no pin declared (a dev checkout), so there is nothing to compare
const describeOpenclawPin = (info) => {
  const installed = typeof info?.installedVersion === "string" && info.installedVersion ? info.installedVersion : null;
  const pinned = typeof info?.pinnedVersion === "string" && info.pinnedVersion ? info.pinnedVersion : null;
  if (!pinned) return { state: "unknown", installed, pinned };
  if (!installed) return { state: "unreadable", installed, pinned };
  return { state: installed === pinned ? "match" : "diverged", installed, pinned };
};

module.exports = { describeOpenclawPin };
