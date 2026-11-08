import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

// The one step indicator for the setup wizard and the Gmail and Telegram
// wizards: "Step n of m", the step title as the h2, then a segmented bar.
// The words are always visible; the bar repeats them for assistive tech
// through role="progressbar" and aria-valuetext. Before the first step
// (current < 0) the count line says "Getting started" and no segment is done.
export const WizardProgress = ({
  steps = [],
  current = 0,
  title = "",
  label = "Setup progress",
}) => {
  const count = steps.length;
  const started = current >= 0;
  const index = started ? Math.min(current, Math.max(count - 1, 0)) : -1;
  const stepTitle = title || (started ? steps[index] : "") || "";
  const countLabel = started ? `Step ${index + 1} of ${count}` : "Getting started";

  return html`
    <div class="ac-wizard-progress">
      <p class="ac-wizard-progress-count">${countLabel}</p>
      <h2 class="ac-wizard-progress-title">${stepTitle}</h2>
      <div
        class="ac-wizard-progress-bar"
        role="progressbar"
        aria-label=${label}
        aria-valuemin="0"
        aria-valuemax=${String(count)}
        aria-valuenow=${String(index + 1)}
        aria-valuetext=${`${countLabel}: ${stepTitle}`}
      >
        ${steps.map(
          (stepLabel, idx) => html`
            <span
              key=${idx}
              class=${`ac-wizard-progress-segment${
                idx < index ? " is-done" : idx === index ? " is-current" : ""
              }`}
            ></span>
          `,
        )}
      </div>
    </div>
  `;
};
