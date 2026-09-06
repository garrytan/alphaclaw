export const normalizeBrowsePath = (value) => String(value || "").replace(/^\/+|\/+$/g, "");

export const buildBrowseRoute = (relativePath, options = {}) => {
  const view = String(options?.view || "edit");
  const encodedPath = String(relativePath || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const baseRoute = encodedPath ? `/browse/${encodedPath}` : "/browse";
  const params = new URLSearchParams();
  if (view === "diff" && encodedPath) params.set("view", "diff");
  if (options.line) params.set("line", String(options.line));
  if (options.lineEnd) params.set("lineEnd", String(options.lineEnd));
  const query = params.toString();
  return query ? `${baseRoute}?${query}` : baseRoute;
};

// `query` is the hash query string the router keeps OUT of `location` so
// route matching works (fix wave F138 — `?view=diff` / `?line=` deep links
// were dead because only the path ever reached here). A query embedded in
// `location` still wins for callers that build full routes.
export const parseBrowseRoute = ({ location = "", browsePreviewPath = "", query = "" } = {}) => {
  const isBrowseRoute = location.startsWith("/browse");
  const browseRoutePath = isBrowseRoute ? String(location || "").split("?")[0] : "";
  const embeddedQuery =
    isBrowseRoute && String(location || "").includes("?")
      ? String(location || "").split("?").slice(1).join("?")
      : "";
  const browseRouteQuery = embeddedQuery || (isBrowseRoute ? String(query || "").replace(/^\?/, "") : "");
  const selectedBrowsePath = isBrowseRoute
    ? browseRoutePath
        .replace(/^\/browse\/?/, "")
        .split("/")
        .filter(Boolean)
        .map((segment) => {
          try {
            return decodeURIComponent(segment);
          } catch {
            return segment;
          }
        })
        .join("/")
    : "";
  const activeBrowsePath = browsePreviewPath || selectedBrowsePath;
  const browseQueryParams = isBrowseRoute ? new URLSearchParams(browseRouteQuery) : null;
  const browseViewerMode =
    !browsePreviewPath && browseQueryParams?.get("view") === "diff"
      ? "diff"
      : "edit";
  const browseLineTarget = Number.parseInt(browseQueryParams?.get("line") || "", 10) || 0;
  const browseLineEndTarget = Number.parseInt(browseQueryParams?.get("lineEnd") || "", 10) || 0;

  return {
    activeBrowsePath,
    browseLineEndTarget,
    browseLineTarget,
    browseViewerMode,
    isBrowseRoute,
    selectedBrowsePath,
  };
};
