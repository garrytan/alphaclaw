import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

// The pin boundary: the server reports openclawPin (lib/server/openclaw-pin-state.js)
// on /api/status. Only a diverged or unreadable install warns; match and an
// undeclared pin (a dev checkout) render nothing.
export const getOpenclawPinWarning = (openclawPin) => {
  if (openclawPin?.state === "diverged") {
    return {
      title: "OpenClaw is not the pinned version",
      body: `OpenClaw ${openclawPin.installed} is installed, but this AlphaClaw release pins ${openclawPin.pinned}. The install is broken or stale: redeploy or reinstall AlphaClaw to restore the pinned version.`,
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
