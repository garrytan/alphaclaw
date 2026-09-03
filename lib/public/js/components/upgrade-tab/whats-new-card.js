import { h } from "preact";
import htm from "htm";
import { Badge } from "../badge.js";

const html = htm.bind(h);

// Curated "What's new" for the selected channel's latest minor (plan item 2.1).
// Hierarchy per the design spec (D5): the security-default flips render FIRST in
// their own amber section — critical behavior changes must never read like ordinary
// release highlights — then the feature highlights. Hidden entirely on stable/dev or
// when no curated entry exists (the per-row release notes below remain the fallback).
export const WhatsNewCard = ({ whatsNew = null, activeChannel = "stable" }) => {
  if (!whatsNew || whatsNew.channel !== activeChannel) return null;
  const flips = Array.isArray(whatsNew.securityFlips) ? whatsNew.securityFlips : [];
  const highlights = Array.isArray(whatsNew.highlights) ? whatsNew.highlights : [];
  if (flips.length === 0 && highlights.length === 0) return null;
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="card-label">What's new in ${whatsNew.minor} (${whatsNew.channel})</h2>
        ${whatsNew.newerThanVerified && whatsNew.lastVerifiedVersion
          ? html`<span class="text-xs text-status-warning-muted">
              tested with ${whatsNew.lastVerifiedVersion}; newer releases may differ
            </span>`
          : null}
      </div>

      ${flips.length > 0
        ? html`
            <div class="ac-surface-inset border border-yellow-500/35 rounded-lg p-3 space-y-2">
              <div class="flex items-center gap-2">
                <${Badge} tone="warning">Security changes to review</${Badge}>
              </div>
              <ul class="space-y-2">
                ${flips.map(
                  (flip) => html`
                    <li class="text-xs">
                      <span class="text-body font-medium">${flip.key}</span>
                      <span class="text-fg-muted"> ${flip.from} → ${flip.to}</span>
                      <p class="text-fg-muted mt-0.5">${flip.warning}</p>
                    </li>
                  `,
                )}
              </ul>
            </div>
          `
        : null}

      ${highlights.length > 0
        ? html`
            <ul class="space-y-1.5">
              ${highlights.map(
                (item) => html`
                  <li class="text-sm">
                    <span class="text-body font-medium">${item.title}</span>
                    <span class="text-fg-muted"> — ${item.body}</span>
                  </li>
                `,
              )}
            </ul>
          `
        : null}

      <p class="text-xs text-fg-muted">
        Full details are in each version's release notes in the catalog below.
      </p>
    </div>
  `;
};
