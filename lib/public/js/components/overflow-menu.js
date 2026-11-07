import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { VerticalDotsIcon } from "./icons.js";

const html = htm.bind(h);

export const OverflowMenu = ({
  open = false,
  onToggle = () => {},
  onClose = () => {},
  ariaLabel = "Open menu",
  title = "",
  menuRef = null,
  renderTrigger = null,
  triggerDisabled = false,
  children = null,
}) => {
  const internalMenuRef = useRef(null);
  const setMenuNodeRef = (node) => {
    internalMenuRef.current = node;
    if (typeof menuRef === "function") {
      menuRef(node);
      return;
    }
    if (menuRef && typeof menuRef === "object") {
      menuRef.current = node;
    }
  };

  useEffect(() => {
    if (!open) return undefined;
    const handleWindowClick = (event) => {
      const root = internalMenuRef.current;
      if (!root) return;
      if (root.contains(event.target)) return;
      onClose(event);
    };
    // Capture phase, so an open menu inside a dialog takes Escape before the
    // dialog does. Escape an IME or another handler already used is ignored,
    // and so is one pressed while focus is somewhere else (a dialog opened
    // over this menu owns that Escape).
    const handleKeyDown = (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const active = globalThis.document?.activeElement;
      const root = internalMenuRef.current;
      if (active && active !== globalThis.document?.body && root && !root.contains(active)) return;
      event.preventDefault();
      onClose(event);
      internalMenuRef.current?.querySelector?.("button")?.focus?.();
    };
    window.addEventListener("click", handleWindowClick);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("click", handleWindowClick);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, onClose]);

  return html`
  <div class="brand-menu" ref=${setMenuNodeRef}>
    ${typeof renderTrigger === "function"
      ? renderTrigger({
          open,
          onToggle: (event) => {
            event.stopPropagation();
            onToggle(event);
          },
          ariaLabel,
          title: title || ariaLabel,
        })
      : html`
          <button
            type="button"
            class="brand-menu-trigger"
            aria-label=${ariaLabel}
            aria-expanded=${open ? "true" : "false"}
            title=${title || ariaLabel}
            disabled=${triggerDisabled}
            onclick=${(event) => {
              event.stopPropagation();
              onToggle(event);
            }}
          >
            <${VerticalDotsIcon} />
          </button>
        `}
    ${open
      ? html`
          <div class="brand-dropdown" onclick=${(event) => event.stopPropagation()}>
            ${children}
          </div>
        `
      : null}
  </div>
`;
};

export const OverflowMenuItem = ({
  children = null,
  onClick = () => {},
  className = "",
  icon = null,
  disabled = false,
}) => html`
  <button
    type="button"
    class=${`brand-dropdown-item ${className} ${disabled
      ? "opacity-50 cursor-not-allowed"
      : ""}`.trim()}
    disabled=${disabled}
    onclick=${(event) => {
      event.stopPropagation();
      if (disabled) return;
      onClick(event);
    }}
  >
    ${icon
      ? html`
          <span class="flex w-full items-center gap-2 leading-none">
            <${icon} className="block w-4 h-4 rounded-sm" />
            <span>${children}</span>
          </span>
        `
      : children}
  </button>
`;
