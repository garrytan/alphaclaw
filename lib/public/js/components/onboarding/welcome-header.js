import { h } from "preact";
import htm from "htm";
import { WizardProgress } from "../wizard-progress.js";

const html = htm.bind(h);

export const WelcomeHeader = ({
  groups,
  isPreStep,
  stepNumber,
  activeStepLabel,
}) => {
  const progressSteps = [
    ...groups.map((group) => group.title),
    "Initializing",
    "Pairing",
  ];

  return html`
    <div class="text-center mb-1">
      <span
        class="ac-logo-mark block mx-auto mb-3"
        style="--ac-logo-width: 32px; --ac-logo-height: 33px;"
        aria-hidden="true"
      ></span>
      <h1 class="text-title font-semibold mb-2">Setup</h1>
      <p style="color: var(--text-muted)" class="text-sm">
        Let's get your agent running
      </p>
    </div>

    <${WizardProgress}
      steps=${progressSteps}
      current=${isPreStep ? -1 : stepNumber - 1}
      title=${isPreStep ? "Choose how to set up this box" : activeStepLabel}
    />
  `;
};
