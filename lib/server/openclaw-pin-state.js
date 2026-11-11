const fs = require("fs");
const path = require("path");
const { compareVersionParts } = require("./helpers");
const { resolveSelfDependency } = require("./self-dependency");
const { readRegularFileBounded } = require("./utils/bounded-file");

// The pin boundary, as one answer for the status payload, the Doctor card,
// the boot verdict and the watchdog. AlphaClaw runs the OpenClaw its
// package.json pins; an installed tree with a different version (or one whose
// version cannot be read) means the image did not install the pin, so the
// operator sees it instead of finding it only in diagnose output. The one
// exception is a deliberate hold (below). Input: openclawRuntime.getInfo().
//   match       installed === pinned
//   held        the deployment holds OpenClaw at the installed version on
//               purpose: an exact `overrides.openclaw` in the app's own
//               package.json, installed === that hold, older than the pin
//               and at or above kOpenclawHoldFloor
//   diverged    both readable, different, and not a hold; with a hold
//               declared, `reason` says why it does not count: "not_held"
//               (a different version is installed), "below_floor" (older
//               than kOpenclawHoldFloor) or "above_pin" (newer than the pin)
//   unreadable  the pin is declared but the installed version is missing or
//               unparseable (no node_modules/openclaw, a torn package.json)
//   unknown     no pin declared (a dev checkout), so there is nothing to compare
//
// The oldest OpenClaw a hold may keep: 2026.10.9, the last release before the
// one-way 2026.11 schema migration, which this release's code still runs. It
// does not move with the pin: raise it only when a change drops support for
// 2026.10.9, and never past the pin.
const kOpenclawHoldFloor = "2026.10.9";
const kExactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

// The deployment's hold: `overrides.openclaw` in the package.json of the app
// that depends on AlphaClaw (e.g. /app in the Render template), as a string
// or npm's `{ ".": "<version>" }` form. Only an exact version is a hold; a
// range, a `$openclaw` reference or AlphaClaw's own package.json is not.
const readOpenclawHold = ({ fsModule = fs, resolveDependency = () => resolveSelfDependency({ fsImpl: fsModule }) } = {}) => {
  try {
    const dependency = resolveDependency();
    if (!dependency?.key || !dependency.installDir) return null;
    const pkg = JSON.parse(readRegularFileBounded(path.join(dependency.installDir, "package.json"), { fsModule }));
    const override = pkg?.overrides?.openclaw;
    const spec = typeof override === "string" ? override : override?.["."];
    return typeof spec === "string" && kExactVersion.test(spec.trim()) ? spec.trim() : null;
  } catch {
    return null;
  }
};

const describeOpenclawPin = (info) => {
  const installed = typeof info?.installedVersion === "string" && info.installedVersion ? info.installedVersion : null;
  const pinned = typeof info?.pinnedVersion === "string" && info.pinnedVersion ? info.pinnedVersion : null;
  const held = typeof info?.heldVersion === "string" && info.heldVersion ? info.heldVersion : null;
  if (!pinned) return { state: "unknown", installed, pinned };
  if (!installed) return { state: "unreadable", installed, pinned };
  if (installed === pinned) return { state: "match", installed, pinned };
  if (!held) return { state: "diverged", installed, pinned };
  if (installed !== held) return { state: "diverged", installed, pinned, held, reason: "not_held" };
  if (compareVersionParts(installed, kOpenclawHoldFloor) < 0) {
    return { state: "diverged", installed, pinned, held, floor: kOpenclawHoldFloor, reason: "below_floor" };
  }
  if (compareVersionParts(installed, pinned) > 0) return { state: "diverged", installed, pinned, held, reason: "above_pin" };
  return { state: "held", installed, pinned, held };
};

// Why a declared hold does not cover a diverged install, as one sentence for
// the Doctor card and diagnose; null when no hold was declared.
const describeHoldRejection = (pin) => {
  if (pin?.state !== "diverged" || !pin.held) return null;
  if (pin.reason === "below_floor") {
    return `This deployment holds OpenClaw at ${pin.held}, older than ${pin.floor}, the oldest version this AlphaClaw supports.`;
  }
  if (pin.reason === "above_pin") {
    return `This deployment holds OpenClaw at ${pin.held}, newer than the pin; a hold can only keep an older supported version.`;
  }
  return `This deployment holds OpenClaw at ${pin.held}, but ${pin.installed} is installed.`;
};

module.exports = { kOpenclawHoldFloor, readOpenclawHold, describeOpenclawPin, describeHoldRejection };
