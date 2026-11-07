import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

const kVariants = {
  pill: {
    list: "flex items-center gap-2",
    tab: "ac-tab inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
    active: "border-tone-accent-border bg-tone-accent-bg text-tone-accent",
    inactive: "border-border bg-field text-fg-muted hover:border-fg-muted hover:text-body",
  },
  segmented: {
    list: "inline-flex items-center rounded-lg border border-border bg-field p-0.5",
    tab: "ac-tab px-2.5 py-1 text-xs rounded-md",
    active: "bg-surface text-bright",
    inactive: "text-fg-muted hover:text-body",
  },
};

export const getTabId = (idBase, value) => `${idBase}-tab-${value}`;
export const getTabPanelId = (idBase, value) => `${idBase}-panel-${value}`;

// Next index for the tablist keyboard model: arrows wrap, Home and End jump.
export const getNextTabIndex = (key, index, count) => {
  if (count <= 0) return -1;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return -1;
};

// Page sub-navigation (WAI-ARIA tabs, automatic activation). Only the
// selected tab is in the Tab order; arrows, Home and End move between tabs
// and select them. Spread getTabPanelProps(idBase, value) on the panel.
export const Tabs = ({
  tabs = [],
  activeTab = "",
  onSelectTab = () => {},
  idBase = "tabs",
  ariaLabel = "",
  variant = "pill",
  className = "",
} = {}) => {
  const styles = kVariants[variant] || kVariants.pill;
  const values = tabs.map((tab) => String(tab?.value ?? ""));
  const selectedIndex = values.indexOf(String(activeTab));

  const handleKeyDown = (event) => {
    const next = getNextTabIndex(event.key, Math.max(selectedIndex, 0), values.length);
    if (next < 0) return;
    event.preventDefault();
    if (next !== selectedIndex) onSelectTab(tabs[next]?.value);
    event.currentTarget?.querySelectorAll?.('[role="tab"]')?.[next]?.focus?.();
  };

  return html`
    <div
      role="tablist"
      aria-label=${ariaLabel || undefined}
      class=${className || styles.list}
      onKeyDown=${handleKeyDown}
    >
      ${tabs.map((tab, index) => {
        const value = values[index];
        const selected = index === selectedIndex;
        return html`
          <button
            key=${value}
            type="button"
            role="tab"
            id=${getTabId(idBase, value)}
            aria-selected=${selected ? "true" : "false"}
            aria-controls=${selected ? getTabPanelId(idBase, value) : undefined}
            tabindex=${selected || (selectedIndex < 0 && index === 0) ? "0" : "-1"}
            class=${`${styles.tab} ${selected ? styles.active : styles.inactive}`}
            onclick=${() => onSelectTab(tab?.value)}
          >
            ${String(tab?.label || tab?.value || "")}
          </button>
        `;
      })}
    </div>
  `;
};

export const getTabPanelProps = (idBase, value) => ({
  role: "tabpanel",
  id: getTabPanelId(idBase, value),
  "aria-labelledby": getTabId(idBase, value),
});
