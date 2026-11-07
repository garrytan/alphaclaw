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

  it("routes a page item and closes the phone drawer", () => {
    const setLocation = vi.fn();
    const onCloseMobileSidebar = vi.fn();
    const { actions } = useBrowseNavigation({ location: "/home", setLocation, onCloseMobileSidebar });
    actions.handleSelectNavItem({ id: "health", path: "/health" });
    expect(setLocation).toHaveBeenCalledWith("/health");
    expect(onCloseMobileSidebar).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
  });

  it("opens Home and scrolls to the Channels section once it renders", () => {
    const setLocation = vi.fn();
    const target = { scrollIntoView: vi.fn() };
    let rendered = false;
    globalThis.document = { getElementById: (id) => (rendered && id === "home-channels" ? target : null) };
    const { actions } = useBrowseNavigation({ location: "/health", setLocation });
    actions.handleSelectNavItem({ id: "channels", path: "/home", anchor: "home-channels" });
    expect(setLocation).toHaveBeenCalledWith("/home");
    frames.shift()();
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    rendered = true;
    frames.shift()();
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(frames).toHaveLength(0);
  });

  it("stops looking for a section that never renders", () => {
    globalThis.document = { getElementById: () => null };
    const { actions } = useBrowseNavigation({ location: "/health", setLocation: () => {} });
    actions.handleSelectNavItem({ id: "integrations", path: "/home", anchor: "home-integrations" });
    let runs = 0;
    while (frames.length) {
      frames.shift()();
      runs += 1;
    }
    expect(runs).toBe(60);
  });
});
