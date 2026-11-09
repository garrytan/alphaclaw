import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hook harness: state initializers run, effects are collected, not run.
vi.mock("preact/hooks", () => {
  const useState = (initialValue) => [
    typeof initialValue === "function" ? initialValue() : initialValue,
    () => {},
  ];
  return {
    useState,
    useRef: (initialValue = null) => ({ current: initialValue }),
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (factory) => factory(),
  };
});

let storedSettings = {};
vi.mock("../../lib/public/js/lib/ui-settings.js", () => ({
  readUiSettings: () => storedSettings,
  writeUiSettings: () => {},
  updateUiSettings: () => {},
}));

import { useBrowseNavigation } from "../../lib/public/js/hooks/use-browse-navigation.js";
import { kNavSections } from "../../lib/public/js/lib/app-navigation.js";

const openMenuFromBrowse = () => {
  const setLocation = vi.fn();
  const { actions } = useBrowseNavigation({ location: "/browse/a.md", setLocation });
  actions.handleSelectSidebarTab("menu");
  return setLocation.mock.calls[0][0];
};

describe("saved last-visited tab", () => {
  it.each([
    ["/watchdog", "/health"],
    ["/general", "/home"],
    ["/cron/nightly", "/schedules/nightly"],
    ["/envars", "/environment"],
    ["/health", "/health"],
    ["/usage/sess-1", "/usage/sess-1"],
  ])("maps a saved %s to %s", (saved, expected) => {
    storedSettings = { lastMenuRoute: saved };
    expect(openMenuFromBrowse()).toBe(expected);
  });

  it.each([["/telegram/default"], ["/nope"], ["watchdog"], [42]])(
    "falls back to Home for %s",
    (saved) => {
      storedSettings = { lastMenuRoute: saved };
      expect(openMenuFromBrowse()).toBe("/home");
    },
  );
});

describe("sidebar tab switch", () => {
  it("reports whether it navigated, so the drawer keeps itself open only for a real navigation", () => {
    storedSettings = {};
    const setLocation = vi.fn();
    const { actions } = useBrowseNavigation({ location: "/health", setLocation });
    expect(actions.handleSelectSidebarTab("menu")).toBe(false);
    expect(setLocation).not.toHaveBeenCalled();
    expect(actions.handleSelectSidebarTab("chat")).toBe(true);
    expect(actions.handleSelectSidebarTab("browse")).toBe(true);
    expect(setLocation).toHaveBeenCalledTimes(2);
  });

  it("reports no navigation for a second tap before the page re-renders", () => {
    storedSettings = {};
    const originalWindow = globalThis.window;
    globalThis.window = { location: { hash: "#/chat" } };
    try {
      const setLocation = vi.fn();
      const { actions } = useBrowseNavigation({ location: "/health", setLocation });
      expect(actions.handleSelectSidebarTab("chat")).toBe(false);
      expect(setLocation).not.toHaveBeenCalled();
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

describe("sidebar items", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let frames;
  beforeEach(() => {
    storedSettings = {};
    frames = [];
    globalThis.window = {
      requestAnimationFrame: (callback) => frames.push(callback),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
  afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  it.each([
    ["/telegram/ops", "/channels"],
    ["/webhooks/github", "/integrations"],
    ["/nodes", "/integrations"],
  ])("Back from %s goes to its parent page %s", (location, expected) => {
    const setLocation = vi.fn();
    const { actions } = useBrowseNavigation({ location, setLocation });
    actions.exitSubScreen();
    expect(setLocation).toHaveBeenCalledWith(expected);
  });

  it("routes a page item and closes the phone drawer", () => {
    const setLocation = vi.fn();
    const onCloseMobileSidebar = vi.fn();
    const { actions } = useBrowseNavigation({ location: "/home", setLocation, onCloseMobileSidebar });
    actions.handleSelectNavItem({ id: "health", path: "/health" });
    expect(setLocation).toHaveBeenCalledWith("/health");
    expect(onCloseMobileSidebar).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });

  it("opens Channels and Integrations on their own pages, with no scroll to a Home section", () => {
    const setLocation = vi.fn();
    const { actions } = useBrowseNavigation({ location: "/health", setLocation });
    const items = kNavSections.flatMap((section) => section.items);
    for (const id of ["channels", "integrations"]) {
      actions.handleSelectNavItem(items.find((item) => item.id === id));
    }
    expect(setLocation.mock.calls).toEqual([["/channels"], ["/integrations"]]);
    expect(frames).toHaveLength(0);
  });
});
