import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { createPortal } from "preact/compat";
import htm from "htm";

const html = htm.bind(h);

const kFocusableSelector = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(", ");

// Open dialogs, oldest first. Only the last one handles Tab and Escape, so a
// ConfirmDialog opened over a modal never lets the modal underneath react.
const openDialogs = [];
let dialogTitleCount = 0;

export const isTopmostDialog = (token) => openDialogs[openDialogs.length - 1] === token;

export const getFocusableElements = (root) => {
  if (!root || typeof root.querySelectorAll !== "function") return [];
  return Array.from(root.querySelectorAll(kFocusableSelector)).filter(
    (element) =>
      !element.disabled &&
      element.type !== "hidden" &&
      element.getAttribute?.("tabindex") !== "-1" &&
      element.getAttribute?.("aria-hidden") !== "true" &&
      (typeof element.getClientRects !== "function" ||
        element.getClientRects().length > 0),
  );
};

// Keeps Tab and Shift+Tab inside root, wrapping at both ends. Focus that has
// left the dialog comes back to its first (or, with Shift, last) control.
export const trapTabKey = (event, root) => {
  if (event.key !== "Tab" || !root) return;
  const focusables = getFocusableElements(root);
  if (focusables.length === 0) {
    event.preventDefault();
    root.focus?.();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = typeof document !== "undefined" ? document.activeElement : null;
  const inside = Boolean(active && root.contains?.(active));
  if (event.shiftKey && (!inside || active === first || active === root)) {
    event.preventDefault();
    last.focus?.();
  } else if (!event.shiftKey && (!inside || active === last)) {
    event.preventDefault();
    first.focus?.();
  }
};

const labelFromHeading = (panel) => {
  const heading = panel.querySelector?.("h1, h2, h3, h4");
  if (!heading) return;
  if (!heading.id) {
    dialogTitleCount += 1;
    heading.id = `ac-dialog-title-${dialogTitleCount}`;
  }
  panel.setAttribute?.("aria-labelledby", heading.id);
};

export const ModalShell = ({
  visible = false,
  onClose = () => {},
  closeOnOverlayClick = true,
  closeOnEscape = true,
  panelClassName = "bg-modal border border-border rounded-xl p-5 max-w-md w-full space-y-3",
  // Accessible name. Without either prop the dialog is named by the first
  // heading inside it.
  ariaLabel = "",
  ariaLabelledby = "",
  children = null,
}) => {
  const overlayPointerDownRef = useRef(false);
  const panelRef = useRef(null);
  const openerRef = useRef(null);
  const wasVisibleRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const closeOnEscapeRef = useRef(closeOnEscape);
  onCloseRef.current = onClose;
  closeOnEscapeRef.current = closeOnEscape;

  // The opener is read while rendering the opening frame, before any child
  // effect can move focus into the dialog.
  if (visible && !wasVisibleRef.current && typeof document !== "undefined") {
    openerRef.current = document.activeElement;
  }
  wasVisibleRef.current = visible;

  useEffect(() => {
    if (!visible) return undefined;
    const token = {};
    openDialogs.push(token);
    const panel = panelRef.current;
    if (panel && !ariaLabel && !ariaLabelledby) labelFromHeading(panel);
    if (panel && !panel.contains?.(document.activeElement)) {
      const autofocusTarget = panel.querySelector?.("[autofocus], [data-autofocus]");
      (autofocusTarget || panel).focus?.({ preventScroll: true });
    }

    const handleKeydown = (event) => {
      if (!isTopmostDialog(token)) return;
      if (event.key === "Tab") {
        trapTabKey(event, panelRef.current);
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (!closeOnEscapeRef.current) return;
      event.preventDefault();
      onCloseRef.current?.();
    };

    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
      const index = openDialogs.indexOf(token);
      if (index >= 0) openDialogs.splice(index, 1);
      const opener = openerRef.current;
      openerRef.current = null;
      if (!opener || opener === document.body || !opener.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !panel?.contains?.(active)) return;
      opener.focus?.({ preventScroll: true });
    };
  }, [visible]);

  if (!visible) return null;

  const content = html`
    <div
      class="fixed inset-0 bg-overlay flex items-start justify-center overflow-y-auto p-4 sm:items-center z-50"
      onpointerdown=${(event) => {
        overlayPointerDownRef.current = event.target === event.currentTarget;
      }}
      onpointerup=${(event) => {
        const shouldClose =
          closeOnOverlayClick &&
          overlayPointerDownRef.current &&
          event.target === event.currentTarget;
        overlayPointerDownRef.current = false;
        if (shouldClose) onClose?.();
      }}
      onpointercancel=${() => {
        overlayPointerDownRef.current = false;
      }}
    >
      <div
        ref=${panelRef}
        class=${`ac-dialog-panel ${panelClassName}`}
        role="dialog"
        aria-modal="true"
        aria-label=${ariaLabel || undefined}
        aria-labelledby=${ariaLabelledby || undefined}
        tabindex="-1"
      >
        ${children}
      </div>
    </div>
  `;
  return typeof document === "undefined" ? content : createPortal(content, document.body);
};
