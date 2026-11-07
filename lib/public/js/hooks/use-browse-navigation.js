import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { readUiSettings, writeUiSettings } from "../lib/ui-settings.js";
import { kDefaultUiTab, getSelectedNavId, kNavSections } from "../lib/app-navigation.js";
import { buildBrowseRoute, normalizeBrowsePath, parseBrowseRoute } from "../lib/browse-route.js";
import { getRoutePath, resolveRoute } from "../lib/routes.js";
import { kBrowseGitSyncedEvent } from "../lib/ui-events.js";

const kBrowseLastPathUiSettingKey = "browseLastPath";
const kLastMenuRouteUiSettingKey = "lastMenuRoute";

export const useBrowseNavigation = ({
  location = "",
  hashQuery = "",
  setLocation = () => {},
  onCloseMobileSidebar = () => {},
} = {}) => {
  const currentRoute = resolveRoute(location).route;
  const routeSidebarTab = currentRoute?.sidebarTab || "menu";
  const [sidebarTab, setSidebarTab] = useState(routeSidebarTab);
  const [lastBrowsePath, setLastBrowsePath] = useState(() => {
    const settings = readUiSettings();
    return typeof settings[kBrowseLastPathUiSettingKey] === "string"
      ? settings[kBrowseLastPathUiSettingKey]
      : "";
  });
  const [lastMenuRoute, setLastMenuRoute] = useState(() => {
    const settings = readUiSettings();
    const storedRoute = settings[kLastMenuRouteUiSettingKey];
    if (typeof storedRoute !== "string" || !storedRoute.startsWith("/")) {
      return `/${kDefaultUiTab}`;
    }
    // A tab saved before the renames (`/watchdog`) comes back as its new hash.
    const { route, redirectTo } = resolveRoute(storedRoute);
    if (!route || route.menuReturn !== "persist") return `/${kDefaultUiTab}`;
    return redirectTo || storedRoute;
  });
  const [browsePreviewPath, setBrowsePreviewPath] = useState("");
  const routeHistoryRef = useRef([]);

  const {
    activeBrowsePath,
    browseLineEndTarget,
    browseLineTarget,
    browseViewerMode,
    isBrowseRoute,
    selectedBrowsePath,
  } = parseBrowseRoute({
    location,
    browsePreviewPath,
    query: hashQuery,
  });

  const selectedNavId = getSelectedNavId({
    isBrowseRoute,
    location,
  });

  // Derive sidebar tab only from `location`. Avoid optimistic setSidebarTab + this effect
  // fighting (e.g. chat tab selected while hash is still /home → pane never mounts).
  useEffect(() => {
    setSidebarTab(routeSidebarTab);
  }, [location]);

  useEffect(() => {
    if (routeSidebarTab === "browse") return;
    setBrowsePreviewPath("");
  }, [location]);

  useEffect(() => {
    const historyStack = routeHistoryRef.current;
    const lastEntry = historyStack[historyStack.length - 1];
    if (lastEntry === location) return;
    historyStack.push(location);
    if (historyStack.length > 100) {
      historyStack.shift();
    }
  }, [location]);

  useEffect(() => {
    if (currentRoute?.menuReturn === "never") return;
    setLastMenuRoute((currentRoute) =>
      currentRoute === location ? currentRoute : location,
    );
  }, [location]);

  useEffect(() => {
    if (!isBrowseRoute) return;
    if (!selectedBrowsePath) return;
    setLastBrowsePath((currentPath) =>
      currentPath === selectedBrowsePath ? currentPath : selectedBrowsePath,
    );
  }, [isBrowseRoute, selectedBrowsePath]);

  useEffect(() => {
    const handleBrowseGitSynced = () => {
      if (!isBrowseRoute || browseViewerMode !== "diff") return;
      const activePath = String(selectedBrowsePath || "").trim();
      if (!activePath) return;
      setLocation(buildBrowseRoute(activePath, { view: "edit" }));
    };
    window.addEventListener(kBrowseGitSyncedEvent, handleBrowseGitSynced);
    return () => {
      window.removeEventListener(kBrowseGitSyncedEvent, handleBrowseGitSynced);
    };
  }, [browseViewerMode, isBrowseRoute, selectedBrowsePath, setLocation]);

  useEffect(() => {
    const settings = readUiSettings();
    settings[kBrowseLastPathUiSettingKey] = lastBrowsePath;
    settings[kLastMenuRouteUiSettingKey] = lastMenuRoute;
    writeUiSettings(settings);
  }, [lastBrowsePath, lastMenuRoute]);

  const navigateToSubScreen = useCallback((screen) => {
    setLocation(`/${screen}`);
    onCloseMobileSidebar();
  }, [onCloseMobileSidebar, setLocation]);

  const handleBrowsePreviewFile = useCallback((nextPreviewPath) => {
    const normalizedPreviewPath = normalizeBrowsePath(nextPreviewPath);
    setBrowsePreviewPath(normalizedPreviewPath);
  }, []);

  const navigateToBrowseFile = useCallback((relativePath, options = {}) => {
    const normalizedTargetPath = normalizeBrowsePath(relativePath);
    const selectingDirectory =
      !!options.directory || String(relativePath || "").trim().endsWith("/");
    const shouldPreservePreview = selectingDirectory && !!options.preservePreview;
    const activePath = normalizeBrowsePath(
      browsePreviewPath || selectedBrowsePath || "",
    );
    const nextPreviewPath =
      shouldPreservePreview && activePath && activePath !== normalizedTargetPath
        ? activePath
        : "";
    setBrowsePreviewPath(nextPreviewPath);
    const routeOptions = selectingDirectory
      ? { ...options, view: "edit" }
      : options;
    setLocation(buildBrowseRoute(normalizedTargetPath, routeOptions));
    onCloseMobileSidebar();
  }, [browsePreviewPath, onCloseMobileSidebar, selectedBrowsePath, setLocation]);

  const handleSelectSidebarTab = useCallback((nextTab) => {
    if (nextTab === "menu" && routeSidebarTab === "browse") {
      setBrowsePreviewPath("");
      setLocation(lastMenuRoute || `/${kDefaultUiTab}`);
      return;
    }
    if (nextTab === "menu" && routeSidebarTab === "chat") {
      setLocation(lastMenuRoute || `/${kDefaultUiTab}`);
      return;
    }
    if (nextTab === "browse" && routeSidebarTab !== "browse") {
      setLocation(buildBrowseRoute(lastBrowsePath));
      return;
    }
    if (nextTab === "chat" && routeSidebarTab !== "chat") {
      setLocation(getRoutePath("chat"));
    }
  }, [lastBrowsePath, lastMenuRoute, routeSidebarTab, setLocation]);

  // An anchor item (Channels and Integrations until PR 3a) opens its page and
  // scrolls to its section once the page has rendered it.
  const handleSelectNavItem = useCallback((item) => {
    setLocation(item.path);
    onCloseMobileSidebar();
    if (!item.anchor) return;
    let framesLeft = 60;
    const scrollToAnchor = () => {
      const target = document.getElementById(item.anchor);
      if (target) {
        target.scrollIntoView({ block: "start" });
        return;
      }
      framesLeft -= 1;
      if (framesLeft > 0) window.requestAnimationFrame(scrollToAnchor);
    };
    window.requestAnimationFrame(scrollToAnchor);
  }, [onCloseMobileSidebar, setLocation]);

  const exitSubScreen = useCallback(() => {
    setLocation(`/${kDefaultUiTab}`);
    onCloseMobileSidebar();
  }, [onCloseMobileSidebar, setLocation]);

  return {
    state: {
      activeBrowsePath,
      browseLineEndTarget,
      browseLineTarget,
      browsePreviewPath,
      browseViewerMode,
      isBrowseRoute,
      routeHistoryRef,
      selectedBrowsePath,
      selectedNavId,
      sidebarTab,
    },
    actions: {
      buildBrowseRoute,
      clearBrowsePreview: () => setBrowsePreviewPath(""),
      exitSubScreen,
      handleBrowsePreviewFile,
      handleSelectNavItem,
      handleSelectSidebarTab,
      navigateToBrowseFile,
      navigateToSubScreen,
    },
    constants: {
      kNavSections,
    },
  };
};
