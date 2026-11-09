import { h } from "preact";
import htm from "htm";
import { LoadingSpinner } from "./loading-spinner.js";

const html = htm.bind(h);

const kToneClassByTone = {
  solid: "ac-btn-solid",
  primary: "ac-btn-cyan",
  secondary: "ac-btn-secondary",
  success: "ac-btn-green",
  danger: "ac-btn-danger",
  ghost: "ac-btn-ghost",
  neutral: "ac-btn-neutral",
  subtle: "ac-btn-neutral",
  warning: "ac-btn-warning",
};
const kToneClassesWithoutDisabledCss = new Set(["ac-btn-neutral", "ac-btn-warning"]);

export const getActionButtonToneClass = (tone, isInteractive, loading = false) => {
  const toneClass = kToneClassByTone[tone] || kToneClassByTone.primary;
  // ac-btn-cyan, -secondary, -green, -danger and -ghost carry their own
  // :disabled rule in theme.css. ac-btn-neutral and ac-btn-warning do not, so
  // a plain disabled button gets the treatment here (without it, it differs
  // from idle only by losing hover, which reads as "clickable but broken").
  // Loading buttons keep their own affordance (pulse/opacity from loadingClass).
  if (!isInteractive && !loading && kToneClassesWithoutDisabledCss.has(toneClass)) {
    return `${toneClass} opacity-50 cursor-not-allowed`;
  }
  return toneClass;
};

const kSizeClassBySize = {
  sm: "h-7 text-xs leading-none px-2.5 py-1 rounded-lg",
  md: "h-9 text-sm font-medium leading-none px-4 rounded-xl",
  lg: "h-10 text-sm font-medium leading-none px-5 rounded-lg",
};
const kIconOnlySizeClassBySize = {
  sm: "h-7 w-7 p-0 rounded-lg",
  md: "h-9 w-9 p-0 rounded-xl",
  lg: "h-10 w-10 p-0 rounded-lg",
};

export const ActionButton = ({
  onClick,
  type = "button",
  disabled = false,
  loading = false,
  tone = "primary",
  size = "sm",
  idleLabel = "Action",
  loadingLabel = "Working…",
  loadingMode = "replace",
  className = "",
  idleIcon = null,
  idleIconClassName = "h-3 w-3",
  iconOnly = false,
  title = "",
  ariaLabel = "",
}) => {
  const isDisabled = disabled || loading;
  const isInteractive = !isDisabled;
  const toneClass = getActionButtonToneClass(tone, isInteractive, loading);
  const sizeClass = iconOnly
    ? kIconOnlySizeClassBySize[size] || kIconOnlySizeClassBySize.sm
    : kSizeClassBySize[size] || kSizeClassBySize.sm;
  const loadingClass = loading
    ? `cursor-not-allowed ${
        tone === "warning"
          ? "opacity-90 animate-pulse shadow-[0_0_0_1px_rgba(234,179,8,0.22),0_0_18px_rgba(234,179,8,0.12)]"
          : "opacity-80"
      }`
    : "";
  const spinnerSizeClass =
    size === "md" || size === "lg" ? "h-4 w-4" : "h-3 w-3";
  const isInlineLoading = loadingMode === "inline";
  const IdleIcon = idleIcon;
  const idleContent =
    iconOnly && IdleIcon
      ? html`<${IdleIcon} className=${idleIconClassName} />`
      : IdleIcon
        ? html`
            <span class="inline-flex items-center gap-1.5 leading-none">
              <${IdleIcon} className=${idleIconClassName} />
              ${idleLabel}
            </span>
          `
        : idleLabel;
  const currentLabel = loading && !isInlineLoading ? loadingLabel : idleContent;

  return html`
    <button
      type=${type}
      onclick=${onClick}
      disabled=${isDisabled}
      title=${title}
      aria-label=${ariaLabel || null}
      class="inline-flex items-center justify-center transition-colors whitespace-nowrap ${sizeClass} ${toneClass} ${loadingClass} ${className}"
    >
      ${isInlineLoading
        ? html`
            <span
              class="relative inline-flex items-center justify-center leading-none"
            >
              <span class=${loading ? "invisible" : ""}>${currentLabel}</span>
              ${loading
                ? html`
                    <span
                      class="absolute inset-0 inline-flex items-center justify-center"
                    >
                      <${LoadingSpinner} className=${spinnerSizeClass} />
                    </span>
                  `
                : null}
            </span>
          `
        : loading
          ? html`
              <span class="inline-flex items-center gap-1.5 leading-none">
                <${LoadingSpinner} className=${spinnerSizeClass} />
                ${currentLabel}
              </span>
            `
          : currentLabel}
    </button>
  `;
};
