import { useState, useEffect, useCallback } from "preact/hooks";
import { kDefaultUiTab } from "../lib/app-navigation.js";

// Route on the PATH only (`#/watchdog?incident=5` must still match /watchdog),
// but keep the query reachable: `useHashLocation` returns [path, setLocation]
// for wouter, and `useHashQuery` returns the raw query string reactively
// (fix wave F138 — stripping it at the router killed browse `?view=diff` /
// `?line=` deep links because parseBrowseRoute only ever saw the path).
const readHash = () => String(window.location.hash || "").replace(/^#/, "");

const getHashPath = () => {
  const hash = readHash().split("?")[0];
  if (!hash) return `/${kDefaultUiTab}`;
  return hash.startsWith("/") ? hash : `/${hash}`;
};

const getHashQuery = () => {
  const hash = readHash();
  const index = hash.indexOf("?");
  return index >= 0 ? hash.slice(index + 1) : "";
};

const normalizeTarget = (to) => (String(to).startsWith("/") ? String(to) : `/${to}`);

export const useHashLocation = () => {
  const [location, setLocationState] = useState(getHashPath);

  useEffect(() => {
    const onHashChange = () => setLocationState(getHashPath());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // `replace: true` rewrites the current history entry instead of pushing one
  // (fix wave F140): redirects and auto-selects used to push, so Back landed
  // on the redirecting route and bounced forward again — a Back-button trap.
  const setLocation = useCallback((to, { replace = false } = {}) => {
    const normalized = normalizeTarget(to);
    const nextHash = `#${normalized}`;
    if (window.location.hash !== nextHash) {
      if (replace && typeof window.location.replace === "function") {
        window.location.replace(nextHash);
        // `replace` does not fire hashchange in every browser; mirror the
        // router state so the app re-renders on the new path.
        setLocationState(getHashPath());
        return;
      }
      window.location.hash = normalized;
      return;
    }
    setLocationState(normalized);
  }, []);

  return [location, setLocation];
};

export const useHashQuery = () => {
  const [query, setQuery] = useState(getHashQuery);
  useEffect(() => {
    const onHashChange = () => setQuery(getHashQuery());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return query;
};

export const getHashRouterPath = getHashPath;
export const getHashRouterQuery = getHashQuery;
