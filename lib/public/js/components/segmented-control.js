import { h } from "preact";
import htm from "htm";
import { Tooltip } from "./tooltip.js";

const html = htm.bind(h);

/**
 * Reusable segmented control (pill toggle).
 *
 * @param {Object}   props
 * @param {Array<{label:string, value:*, title?:string}>} props.options
 * @param {*}        props.value        Currently selected value.
 * @param {Function} props.onChange      Called with the new value on click.
 * @param {string}   [props.className]  Extra classes on the wrapper.
 * @param {"sm"|"lg"} [props.size]      Visual size variant.
 * @param {boolean}  [props.fullWidth]  Stretch wrapper and options to 100%.
 * @param {boolean}  [props.disabled]   Grey out and ignore clicks (default enabled).
 */
export const SegmentedControl = ({
  options = [],
  value,
  onChange = () => {},
  className = "",
  size = "sm",
  fullWidth = false,
  disabled = false,
}) => html`
  <div
    class=${`ac-segmented-control ${size === "lg" ? "ac-segmented-control-lg" : ""} ${fullWidth ? "ac-segmented-control-full" : ""} ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`.trim()}
  >
    ${options.map(
      (option) => {
        const btn = html`
          <button
            class=${`ac-segmented-control-button ${option.value === value ? "active" : ""}`}
            disabled=${disabled}
            onclick=${() => {
              if (!disabled) onChange(option.value);
            }}
          >
            ${option.label}
          </button>
        `;
        return option.title
          ? html`<${Tooltip} text=${option.title} delay=${1000} widthClass="w-auto max-w-64 whitespace-normal">${btn}</${Tooltip}>`
          : btn;
      },
    )}
  </div>
`;
