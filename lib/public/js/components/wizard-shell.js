import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { ModalShell } from "./modal-shell.js";
import { CloseIcon } from "./icons.js";

const html = htm.bind(h);

// Shared guided-wizard chrome (plan item 2.6), extracted from NodesSetupWizard so the
// Team enable wizard and the Buzz channel wizard don't each hand-roll a 4th/5th copy:
// small label, thin progress segments, "Step N of M: title" heading, step body, and a
// footer slot for Back/Next. Accessibility is built in so every consumer inherits it:
// dialog semantics, labelled progress with aria-current on the active step, focus
// moved into the dialog on open and on step changes (screen readers announce the new
// step), Escape via ModalShell.
export const WizardShell = ({
  visible = false,
  onClose = () => {},
  label = "Setup Wizard",
  steps = [],
  step = 0,
  closeOnEscape = false,
  closeOnOverlayClick = false,
  panelClassName = "relative bg-modal border border-border rounded-xl p-6 max-w-2xl w-full space-y-4",
  footer = null,
  children = null,
}) => {
  const headingRef = useRef(null);
  const rootRef = useRef(null);
  const stepCount = Array.isArray(steps) ? steps.length : 0;
  const boundedStep = Math.min(Math.max(step, 0), Math.max(stepCount - 1, 0));
  const stepTitle = stepCount > 0 ? steps[boundedStep] : "";

  // Move focus to the step heading on open and on every step change so keyboard
  // and screen-reader users land on "Step N of M: ..." instead of a stale control.
  useEffect(() => {
    if (!visible) return;
    headingRef.current?.focus?.();
  }, [visible, boundedStep]);

  // Focus trap (2.6/CEO 14): Tab cycles within the dialog — focus never
  // escapes to the page behind the overlay.
  const handleTrapKeyDown = (event) => {
    if (event.key !== "Tab") return;
    const root = rootRef.current;
    if (!root || typeof root.querySelectorAll !== "function") return;
    const focusables = Array.from(
      root.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.disabled && el.getAttribute?.("aria-hidden") !== "true");
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active =
      typeof document !== "undefined" ? document.activeElement : null;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus?.();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus?.();
    }
  };

  return html`
    <${ModalShell}
      visible=${visible}
      onClose=${onClose}
      closeOnOverlayClick=${closeOnOverlayClick}
      closeOnEscape=${closeOnEscape}
      panelClassName=${panelClassName}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label=${label}
        class="space-y-4"
        ref=${rootRef}
        onKeyDown=${handleTrapKeyDown}
      >
        <button
          type="button"
          onclick=${onClose}
          class="absolute top-6 right-6 h-8 w-8 inline-flex items-center justify-center rounded-lg ac-btn-secondary"
          aria-label="Close wizard"
        >
          <${CloseIcon} className="w-3.5 h-3.5 text-body" />
        </button>

        <div class="text-xs text-fg-muted">${label}</div>
        <div
          class="flex items-center gap-1"
          role="list"
          aria-label=${`Progress: step ${boundedStep + 1} of ${stepCount}`}
        >
          ${(Array.isArray(steps) ? steps : []).map(
            (stepLabel, idx) => html`
              <div
                role="listitem"
                aria-label=${stepLabel}
                aria-current=${idx === boundedStep ? "step" : undefined}
                class=${`h-1 flex-1 rounded-full transition-colors ${idx <= boundedStep ? "bg-accent" : "bg-border"}`}
                style=${idx <= boundedStep ? "background: var(--accent)" : ""}
              ></div>
            `,
          )}
        </div>
        <h3 ref=${headingRef} tabindex="-1" class="font-semibold text-base outline-none">
          Step ${boundedStep + 1} of ${stepCount}: ${stepTitle}
        </h3>

        ${children}

        ${footer ? html`<div class="pt-1">${footer}</div>` : null}
      </div>
    </${ModalShell}>
  `;
};
