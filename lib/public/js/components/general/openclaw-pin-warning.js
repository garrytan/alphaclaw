import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

// The pin boundary: the server reports openclawPin (lib/server/openclaw-pin-state.js)
// on /api/status. Only a diverged or unreadable install warns; match, a
// deliberate hold and an undeclared pin (a dev checkout) render no warning.
const kHoldRejectionCopy = {
  not_held: (pin) => `This deployment holds OpenClaw at ${pin.held}, but ${pin.installed} is installed.`,
  below_floor: (pin) =>
    `This deployment holds OpenClaw at ${pin.held}, older than ${pin.floor}, the oldest version this AlphaClaw supports.`,
  above_pin: (pin) =>
    `This deployment holds OpenClaw at ${pin.held}, newer than the pin; a hold can only keep an older supported version.`,
};

export const getOpenclawPinWarning = (openclawPin) => {
  if (openclawPin?.state === "diverged") {
    const hold = kHoldRejectionCopy[openclawPin.reason]?.(openclawPin);
    return {
      title: "OpenClaw is not the pinned version",
      body: hold
        ? `OpenClaw ${openclawPin.installed} is installed, but this AlphaClaw release pins ${openclawPin.pinned}. ${hold} Redeploy with a supported hold, or remove the hold to run the pinned version.`
        : `OpenClaw ${openclawPin.installed} is installed, but this AlphaClaw release pins ${openclawPin.pinned}. The install is broken or stale: redeploy or reinstall AlphaClaw to restore the pinned version.`,
    };
  }
  if (openclawPin?.state === "unreadable") {
    return {
      title: "OpenClaw version unreadable",
      body: `AlphaClaw cannot read the installed OpenClaw version (this release pins ${openclawPin.pinned}). Redeploy or reinstall AlphaClaw so the pinned version is installed completely.`,
    };
  }
  return null;
};

// The version line's note for a deliberate hold, e.g. "held (pin 2026.11.2)".
export const describeOpenclawHold = (openclawPin) =>
  openclawPin?.state === "held" ? `held (pin ${openclawPin.pinned})` : null;

export const OpenclawPinWarning = ({ openclawPin = null }) => {
  const warning = getOpenclawPinWarning(openclawPin);
  if (!warning) return null;
  return html`
    <div class="bg-yellow-500/10 border border-yellow-500/35 rounded-xl p-4" role="status">
      <h2 class="font-semibold text-sm text-status-warning">${warning.title}</h2>
      <p class="mt-1 text-xs text-status-warning/80">${warning.body}</p>
    </div>
  `;
};
