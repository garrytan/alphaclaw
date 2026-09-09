const fs = require("fs");
const path = require("path");
const {
  kOpenclawRegistryUrl,
  kOpenclawGithubApiBaseUrl,
  kOpenclawCatalogCacheDir,
  kOpenclawCatalogCacheTtlMs,
  kOpenclawCatalogHardStaleMs,
  kOpenclawStableCatalogCount,
  kOpenclawBetaCatalogCount,
  kOpenclawDevCommitCap,
  kOpenclawDevCommitFallbackCount,
} = require("./constants");
const { compareVersionParts } = require("./helpers");

const kGithubReleasesCacheFile = "github-releases.json";
const kNpmAbbrevCacheFile = "npm-abbrev.json";
const kDevCommitsCacheFile = "dev-commits.json";
// The full npm registry doc for openclaw is MB-scale; the abbreviated
// install doc carries everything the catalog needs (dist-tags + engines).
const kNpmAbbreviatedAccept = "application/vnd.npm.install-v1+json";
const kGithubAccept = "application/vnd.github+json";
const kUserAgent = "alphaclaw";
const kForceRefreshMinIntervalMs = 30_000;
// Fetches without a deadline can stall an apply while managed-operation mode
// has crash accounting suspended.
const kFetchTimeoutMs = 20_000;

const fetchAbortSignal = () => {
  try {
    return AbortSignal.timeout(kFetchTimeoutMs);
  } catch {
    return undefined;
  }
};
// Bare numeric hotfix suffixes like "2026.7.1-2" are stable hotfixes, not
// prereleases — only named channels with a dotted counter classify as beta.
const kPrereleasePattern = /-(beta|alpha|rc|next|canary)\./i;

const classifyPrerelease = (version) =>
  kPrereleasePattern.test(String(version || ""));

// Carries the HTTP status so degraded fallbacks can tell a GitHub rate limit
// (403/429 without a token) apart from other failures.
const httpError = (message, status) =>
  Object.assign(new Error(message), { status });

const isRateLimitStatus = (status) => status === 403 || status === 429;

const readEtagHeader = (response) => {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get("etag") || headers.get("ETag") || null;
  }
  return headers.etag || headers.ETag || null;
};

const toTimestamp = (value) => {
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? ts : 0;
};

const byPublishedAtDesc = (a, b) =>
  toTimestamp(b.publishedAt) - toTimestamp(a.publishedAt);
// Rows are npm versions (v0.9.81, D14) and npm versions carry no publish
// date, so VERSION order is the only key every row has. The same comparator
// the What's-new resolver and the apply path use (helpers.compareVersionParts:
// prerelease below its base, numeric hotfix above it).
const byVersionDesc = (a, b) => compareVersionParts(b.version, a.version);
// Sidecar beside each cache blob (v0.9.81, D20): `{ fetchedAt, lastFailure }`.
// A 304 bumps fetchedAt here instead of rewriting the MB-scale blob, and the
// last fetch failure survives a restart, so neither the "as of" stamp nor the
// degraded flag lies after every apply's process restart.
const metaFileFor = (name) => `${name}.meta.json`;

const normalizeRelease = (release) => {
  const tagName = String(release?.tag_name || "").trim();
  const version = tagName.replace(/^v/, "");
  return {
    version,
    tagName,
    publishedAt: release?.published_at || null,
    notes: release?.body || null,
    prerelease: classifyPrerelease(version) || release?.prerelease === true,
    notesUnavailable: false,
  };
};

const toCommitRow = (entry) => {
  const sha = String(entry?.sha || "");
  const message = String(entry?.commit?.message || "");
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject: message.split(/\r?\n/)[0].trim(),
    date: entry?.commit?.author?.date || entry?.commit?.committer?.date || null,
    applyPayload: { channel: "dev", sha },
  };
};

const createOpenclawReleasesService = ({
  fetchImpl = global.fetch,
  fsModule = fs,
  cacheDir = kOpenclawCatalogCacheDir,
  cacheTtlMs = kOpenclawCatalogCacheTtlMs,
  // v0.9.81 (D6): past this age the npm doc (the row source) is awaited, not
  // served stale-while-revalidate; GitHub (notes, dates) stays SWR at any age.
  hardStaleMs = kOpenclawCatalogHardStaleMs,
  // The "Check now" floor, injectable so the throttle report is testable.
  forceRefreshMinIntervalMs = kForceRefreshMinIntervalMs,
  getGithubToken = () => null,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  // Most recent catalog data, kept so isKnownVersion/isKnownCommit and
  // getReleaseNotes can answer without another fetch.
  let kLastState = {
    releases: null, // normalized release entries or null
    npmDoc: null, // { distTags, versions } or null
    devCommits: null, // CommitRow[] or null
  };

  const warn = (message) => {
    try {
      logger?.warn?.(`[alphaclaw] openclaw-releases: ${message}`);
    } catch {}
  };

  // In-memory layer over the disk cache: the GitHub payload is MB-scale and
  // getCatalog runs per request — re-reading + re-parsing it from disk inside
  // the TTL window (and rewriting the whole blob on a 304 just to bump
  // fetchedAt) is repeated synchronous work for identical data. This process
  // is the only writer, so the memo cannot go stale.
  const memoCache = new Map();
  // One in-flight background revalidation per cache file; a stale read that
  // arrives while one is running just reuses it.
  const revalidations = new Map();
  // Last fetch failure per cache file, so stale-while-revalidate reads can
  // still report degraded (and rate-limited) after a revalidation failed.
  // Seeded from the sidecar on the first disk read so a restart cannot hide
  // a degradation (v0.9.81, D20).
  const sourceFailures = new Map();

  const readMetaFile = (name) => {
    try {
      const parsed = JSON.parse(
        fsModule.readFileSync(path.join(cacheDir, metaFileFor(name)), "utf8"),
      );
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  };

  const writeMetaFile = (name, meta) => {
    try {
      fsModule.mkdirSync(cacheDir, { recursive: true });
      fsModule.writeFileSync(path.join(cacheDir, metaFileFor(name)), JSON.stringify(meta));
    } catch (err) {
      warn(`could not write cache sidecar ${metaFileFor(name)}: ${err?.message || err}`);
    }
  };

  const readCacheFile = (name) => {
    if (memoCache.has(name)) return memoCache.get(name);
    let entry = null;
    try {
      const parsed = JSON.parse(
        fsModule.readFileSync(path.join(cacheDir, name), "utf8"),
      );
      if (parsed && typeof parsed === "object" && "data" in parsed) {
        entry = parsed;
      }
    } catch {}
    if (entry) {
      // The sidecar's stamp wins when it is newer: a 304 bumped it without
      // rewriting the blob. Its lastFailure seeds the in-memory flag once.
      const meta = readMetaFile(name);
      if (Number.isFinite(meta?.fetchedAt) && meta.fetchedAt > Number(entry.fetchedAt || 0)) {
        entry = { ...entry, fetchedAt: meta.fetchedAt };
      }
      if (meta?.lastFailure && typeof meta.lastFailure === "object" && !sourceFailures.has(name)) {
        sourceFailures.set(name, {
          rateLimited: meta.lastFailure.rateLimited === true,
          at: Number.isFinite(meta.lastFailure.at) ? meta.lastFailure.at : null,
          status: Number.isFinite(meta.lastFailure.status) ? meta.lastFailure.status : null,
        });
      }
    }
    memoCache.set(name, entry);
    return entry;
  };

  const writeCacheFile = (name, entry) => {
    memoCache.set(name, entry);
    try {
      fsModule.mkdirSync(cacheDir, { recursive: true });
      fsModule.writeFileSync(path.join(cacheDir, name), JSON.stringify(entry));
    } catch (err) {
      warn(`could not write cache file ${name}: ${err?.message || err}`);
    }
    // A fresh blob supersedes any older stamp or failure the sidecar held.
    writeMetaFile(name, { fetchedAt: entry.fetchedAt, lastFailure: null });
  };

  // A 304 only proves freshness — update the memo's fetchedAt and the tiny
  // sidecar instead of rewriting the MB-scale blob to disk, so the stamp
  // survives a restart (v0.9.81; it used to revert to the last 200's time).
  const touchCacheFile = (name, entry, fetchedAt) => {
    memoCache.set(name, { ...entry, fetchedAt });
    writeMetaFile(name, { fetchedAt, lastFailure: null });
  };

  const githubHeaders = ({ etag = null } = {}) => {
    const headers = { Accept: kGithubAccept, "User-Agent": kUserAgent };
    const token = String(
      (typeof getGithubToken === "function" && getGithubToken()) || "",
    ).trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (etag) headers["If-None-Match"] = etag;
    return headers;
  };

  const npmHeaders = ({ etag = null } = {}) => {
    const headers = { Accept: kNpmAbbreviatedAccept, "User-Agent": kUserAgent };
    if (etag) headers["If-None-Match"] = etag;
    return headers;
  };

  const recordFailure = (cacheFile, err) => {
    const failure = {
      rateLimited: isRateLimitStatus(err?.status),
      at: nowFn(),
      status: Number.isFinite(err?.status) ? err.status : null,
    };
    sourceFailures.set(cacheFile, failure);
    const cached = memoCache.get(cacheFile) || null;
    writeMetaFile(cacheFile, {
      fetchedAt: Number.isFinite(cached?.fetchedAt) ? cached.fetchedAt : null,
      lastFailure: failure,
    });
  };

  const revalidateSource = ({ cacheFile, doFetch, label }) => {
    const inFlight = revalidations.get(cacheFile);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const cached = readCacheFile(cacheFile);
      const now = nowFn();
      try {
        const result = await doFetch({ cached });
        if (result.notModified) {
          if (cached) touchCacheFile(cacheFile, cached, now);
        } else {
          writeCacheFile(cacheFile, {
            etag: result.etag || null,
            fetchedAt: now,
            data: result.data,
          });
        }
        sourceFailures.delete(cacheFile);
      } catch (err) {
        recordFailure(cacheFile, err);
        warn(`${label} background revalidation failed: ${err?.message || err}`);
      }
    })().finally(() => {
      revalidations.delete(cacheFile);
    });
    revalidations.set(cacheFile, promise);
    return promise;
  };

  // Shared disk-cache flow: fresh within TTL → no fetch; past-TTL cache hits
  // return stale data immediately and revalidate in the background (SWR);
  // forceRefresh and cold caches block on a fetch with If-None-Match,
  // honoring 304s; on fetch failure fall back to stale cache data.
  //
  // v0.9.81 (D6): a source loaded with `hardStaleMs` (the npm doc — the row
  // source) is AWAITED once its cache is older than that, bounded by the
  // fetch timeout and falling back to the stale copy on failure; the
  // 10-60 min band keeps SWR. GitHub never passes it: a rate-limited GitHub
  // must not block first paint for notes and dates.
  const loadSource = async ({ cacheFile, forceRefresh, doFetch, label, hardStaleMs: hardStale = 0 }) => {
    const cached = readCacheFile(cacheFile);
    const now = nowFn();
    if (cached && !forceRefresh) {
      if (now - cached.fetchedAt < cacheTtlMs) {
        return {
          data: cached.data,
          fetchedAt: cached.fetchedAt,
          degraded: false,
          stale: false,
          rateLimited: false,
        };
      }
      const revalidation = revalidateSource({ cacheFile, doFetch, label });
      if (Number.isFinite(hardStale) && hardStale > 0 && now - cached.fetchedAt >= hardStale) {
        await revalidation;
        const refreshed = readCacheFile(cacheFile) || cached;
        const failure = sourceFailures.get(cacheFile);
        return {
          data: refreshed.data,
          fetchedAt: refreshed.fetchedAt,
          degraded: Boolean(failure),
          stale: Boolean(failure),
          rateLimited: failure?.rateLimited === true,
          awaited: true,
        };
      }
      const failure = sourceFailures.get(cacheFile);
      return {
        data: cached.data,
        fetchedAt: cached.fetchedAt,
        degraded: Boolean(failure),
        stale: true,
        rateLimited: failure?.rateLimited === true,
      };
    }
    try {
      const result = await doFetch({ cached });
      if (result.notModified) {
        if (!cached) {
          throw new Error(`${label} returned 304 without a cached copy`);
        }
        touchCacheFile(cacheFile, cached, now);
        sourceFailures.delete(cacheFile);
        return { data: cached.data, fetchedAt: now, degraded: false, stale: false, rateLimited: false };
      }
      writeCacheFile(cacheFile, {
        etag: result.etag || null,
        fetchedAt: now,
        data: result.data,
      });
      sourceFailures.delete(cacheFile);
      return { data: result.data, fetchedAt: now, degraded: false, stale: false, rateLimited: false };
    } catch (err) {
      recordFailure(cacheFile, err);
      warn(`${label} fetch failed: ${err?.message || err}`);
      const rateLimited = isRateLimitStatus(err?.status);
      if (cached) {
        // Better stale than nothing — surface the cache, flagged degraded.
        return {
          data: cached.data,
          fetchedAt: cached.fetchedAt,
          degraded: true,
          stale: true,
          rateLimited,
        };
      }
      return { data: null, fetchedAt: null, degraded: true, stale: false, rateLimited };
    }
  };

  // Test hook: settle every background revalidation (a settling one can kick
  // another, so loop until the map drains).
  const __awaitRevalidations = async () => {
    while (revalidations.size > 0) {
      await Promise.all([...revalidations.values()]);
    }
  };

  const fetchGithubReleases = async ({ cached }) => {
    const firstPageUrl = `${kOpenclawGithubApiBaseUrl}/releases?per_page=100`;
    const response = await fetchImpl(firstPageUrl, {
      headers: githubHeaders({ etag: cached?.etag || null }),
      signal: fetchAbortSignal(),
    });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) {
      throw httpError(
        `GitHub releases request failed (${response.status})`,
        response.status,
      );
    }
    const firstPage = await response.json();
    let releases = Array.isArray(firstPage) ? firstPage : [];
    if (releases.length === 100) {
      try {
        const nextResponse = await fetchImpl(`${firstPageUrl}&page=2`, {
          headers: githubHeaders(),
          signal: fetchAbortSignal(),
        });
        if (nextResponse.ok) {
          const nextPage = await nextResponse.json();
          if (Array.isArray(nextPage)) releases = releases.concat(nextPage);
        }
      } catch (err) {
        warn(`GitHub releases page 2 fetch failed: ${err?.message || err}`);
      }
    }
    return { data: releases, etag: readEtagHeader(response) };
  };

  const fetchNpmAbbrevDoc = async ({ cached }) => {
    const response = await fetchImpl(kOpenclawRegistryUrl, {
      headers: npmHeaders({ etag: cached?.etag || null }),
      signal: fetchAbortSignal(),
    });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) {
      throw httpError(
        `npm registry request failed (${response.status})`,
        response.status,
      );
    }
    const doc = await response.json();
    return {
      data: {
        distTags:
          doc && typeof doc["dist-tags"] === "object" ? doc["dist-tags"] : null,
        versions:
          doc && doc.versions && typeof doc.versions === "object"
            ? doc.versions
            : {},
      },
      etag: readEtagHeader(response),
    };
  };

  // The dev window is "what is on main beyond the second-newest beta" — the
  // newest beta is often mid-bake, so the one before it anchors the compare.
  const resolveDevBaseTag = (normalizedReleases) => {
    if (!Array.isArray(normalizedReleases)) return null;
    const betas = normalizedReleases
      .filter((entry) => entry.prerelease)
      .sort(byPublishedAtDesc);
    return betas[1]?.version ? `v${betas[1].version}` : null;
  };

  const createDevCommitsFetcher = ({ baseTag }) => async ({ cached }) => {
    if (baseTag) {
      const compareUrl = `${kOpenclawGithubApiBaseUrl}/compare/${baseTag}...main?per_page=250`;
      // The ETag is only valid for the exact URL it came from.
      const etag = cached?.data?.url === compareUrl ? cached?.etag || null : null;
      const response = await fetchImpl(compareUrl, {
        headers: githubHeaders({ etag }),
        signal: fetchAbortSignal(),
      });
      if (response.status === 304) return { notModified: true };
      if (response.ok) {
        const payload = await response.json();
        const rawCommits = Array.isArray(payload?.commits)
          ? payload.commits
          : [];
        // GitHub compare lists commits oldest-first; the catalog wants newest-first.
        const newestFirst = rawCommits.slice().reverse();
        const totalCommits = Number(payload?.total_commits);
        const truncated =
          newestFirst.length > kOpenclawDevCommitCap ||
          (Number.isFinite(totalCommits) && totalCommits > kOpenclawDevCommitCap);
        return {
          data: {
            url: compareUrl,
            baseTag,
            source: "compare",
            truncated,
            commits: newestFirst
              .slice(0, kOpenclawDevCommitCap)
              .map(toCommitRow),
          },
          etag: readEtagHeader(response),
        };
      }
      if (response.status !== 404) {
        throw httpError(
          `GitHub compare request failed (${response.status})`,
          response.status,
        );
      }
      // 404 (e.g. tag deleted) → fall through to the plain commits listing.
    }
    const fallbackUrl = `${kOpenclawGithubApiBaseUrl}/commits?sha=main&per_page=${kOpenclawDevCommitFallbackCount}`;
    const etag = cached?.data?.url === fallbackUrl ? cached?.etag || null : null;
    const response = await fetchImpl(fallbackUrl, {
      headers: githubHeaders({ etag }),
      signal: fetchAbortSignal(),
    });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) {
      throw httpError(
        `GitHub commits request failed (${response.status})`,
        response.status,
      );
    }
    const payload = await response.json();
    const list = Array.isArray(payload) ? payload : [];
    return {
      data: {
        url: fallbackUrl,
        baseTag: null,
        source: "fallback",
        truncated: false,
        // The commits endpoint already returns newest-first.
        commits: list.slice(0, kOpenclawDevCommitCap).map(toCommitRow),
      },
      etag: readEtagHeader(response),
    };
  };

  const toReleaseRow = ({ entry, channel, distTags, npmVersions }) => ({
    version: entry.version,
    publishedAt: entry.publishedAt,
    prerelease: entry.prerelease,
    isDistTagLatest: Boolean(distTags && entry.version === distTags.latest),
    engines: npmVersions?.[entry.version]?.engines || null,
    notes: entry.notes,
    notesUnavailable: entry.notesUnavailable === true,
    applyPayload: { channel, version: entry.version },
  });

  // Rows are the npm abbreviated doc's versions — the install source of truth
  // (isKnownVersion reads the same doc) — each enriched with its GitHub
  // release's notes/publishedAt when one exists (v0.9.81, cross-model D14).
  // Upstream publishes to npm first and creates the GitHub release hours
  // later, so a GitHub-first catalog hid the newest installable version for
  // most of a day (2026.9.3: ~20 h). A GitHub release with no npm version is
  // NOT a row (it cannot be installed); a version npm marks `deprecated` is
  // skipped (D11); a dist-tag target missing from `versions` is still a row.
  // Prerelease = the version's own suffix OR the GitHub prerelease flag.
  const buildNpmEntries = (npmDoc, normalizedReleases) => {
    const releaseByVersion = new Map(
      (Array.isArray(normalizedReleases) ? normalizedReleases : []).map((entry) => [
        entry.version,
        entry,
      ]),
    );
    const versionsDoc = npmDoc?.versions || {};
    const versions = Object.keys(versionsDoc).filter(
      (version) => !versionsDoc[version]?.deprecated,
    );
    const seen = new Set(versions);
    for (const target of Object.values(npmDoc?.distTags || {})) {
      const version = String(target || "");
      if (version && !seen.has(version)) {
        seen.add(version);
        versions.push(version);
      }
    }
    return versions
      .map((version) => {
        const release = releaseByVersion.get(version) || null;
        return {
          version,
          publishedAt: release?.publishedAt ?? null,
          notes: release?.notes ?? null,
          prerelease: classifyPrerelease(version) || release?.prerelease === true,
          notesUnavailable: !release,
        };
      })
      .sort(byVersionDesc);
  };

  const buildUnavailableCatalog = (message, { githubRateLimited = false } = {}) => ({
    ok: false,
    code: "catalog_unavailable",
    message:
      String(message || "").trim() ||
      "Could not load the OpenClaw release catalog from GitHub or npm.",
    hint: "Check the server's network access (and GITHUB_TOKEN if configured), then refresh the catalog.",
    docsUrl: null,
    degraded: { github: true, npm: true, githubRateLimited },
    staleAsOf: null,
    distTags: null,
    stable: [],
    beta: [],
    dev: { commits: [], truncated: false, baseTag: null, source: null },
  });

  let lastForceRefreshAt = 0;
  let inFlightCatalog = null;

  const computeCatalog = async (effectiveForce) => {
    try {
      const releasesPromise = loadSource({
        cacheFile: kGithubReleasesCacheFile,
        forceRefresh: effectiveForce,
        doFetch: fetchGithubReleases,
        label: "GitHub releases",
      });
      const npmPromise = loadSource({
        cacheFile: kNpmAbbrevCacheFile,
        forceRefresh: effectiveForce,
        doFetch: fetchNpmAbbrevDoc,
        label: "npm registry",
        hardStaleMs,
      });
      // Dev commits only need the releases result (for the beta base tag), so
      // the fetch starts as soon as releases resolves instead of waiting on npm.
      const devPromise = releasesPromise.then((releasesResult) => {
        const rawReleases = Array.isArray(releasesResult.data)
          ? releasesResult.data
          : null;
        const normalizedReleases = rawReleases
          ? rawReleases.map(normalizeRelease).sort(byPublishedAtDesc)
          : null;
        return loadSource({
          cacheFile: kDevCommitsCacheFile,
          forceRefresh: effectiveForce,
          doFetch: createDevCommitsFetcher({
            baseTag: resolveDevBaseTag(normalizedReleases),
          }),
          label: "GitHub dev commits",
        }).then((devResult) => ({ devResult, normalizedReleases }));
      });
      const [releasesResult, npmResult, { devResult, normalizedReleases }] =
        await Promise.all([releasesPromise, npmPromise, devPromise]);
      const rawReleases = Array.isArray(releasesResult.data)
        ? releasesResult.data
        : null;
      const npmDoc = npmResult.data || null;

      if (!rawReleases && !npmDoc) {
        return buildUnavailableCatalog(null, {
          githubRateLimited: Boolean(releasesResult.rateLimited),
        });
      }

      const devData = devResult.data || null;
      const dev = devData
        ? {
            commits: Array.isArray(devData.commits) ? devData.commits : [],
            truncated: devData.truncated === true,
            baseTag: devData.baseTag || null,
            source: devData.source || null,
          }
        : { commits: [], truncated: false, baseTag: null, source: null };

      const distTags = npmDoc?.distTags || null;
      const npmVersions = npmDoc ? npmDoc.versions || {} : null;

      // Rows: npm versions enriched by GitHub (D14). Only when npm data is
      // absent altogether (cold cache + npm down) do GitHub releases stand in
      // — flagged degraded.npm below, engines/dist-tag unknown. Version
      // order in both cases; the 5-row caps apply AFTER the merge.
      const npmHasVersions = Boolean(npmDoc && Object.keys(npmVersions || {}).length > 0);
      const entries = npmHasVersions
        ? buildNpmEntries(npmDoc, normalizedReleases)
        : (normalizedReleases || []).slice().sort(byVersionDesc);
      const rowSource = npmHasVersions ? "npm" : "github";
      const stable = entries
        .filter((entry) => !entry.prerelease)
        .slice(0, kOpenclawStableCatalogCount)
        .map((entry) =>
          toReleaseRow({ entry, channel: "stable", distTags, npmVersions }),
        );
      const beta = entries
        .filter((entry) => entry.prerelease)
        .slice(0, kOpenclawBetaCatalogCount)
        .map((entry) =>
          toReleaseRow({ entry, channel: "beta", distTags, npmVersions }),
        );

      // "Catalog as of" is the oldest ROW-PRODUCING source (GitHub releases,
      // npm) — never the dev-commits fetch, whose rate-limited staleness used
      // to keep the label at "20 hours ago" forever (v0.9.81, RC1c).
      const fetchedAts = [];
      if (rawReleases && Number.isFinite(releasesResult.fetchedAt)) {
        fetchedAts.push(releasesResult.fetchedAt);
      }
      if (npmDoc && Number.isFinite(npmResult.fetchedAt)) {
        fetchedAts.push(npmResult.fetchedAt);
      }
      const staleAsOf = fetchedAts.length
        ? new Date(Math.min(...fetchedAts)).toISOString()
        : null;
      const describeSource = (result, present) => ({
        fetchedAt:
          present && Number.isFinite(result.fetchedAt)
            ? new Date(result.fetchedAt).toISOString()
            : null,
        stale: Boolean(result.stale),
        degraded: Boolean(result.degraded),
        rateLimited: Boolean(result.rateLimited),
        ...(result.awaited ? { awaited: true } : {}),
      });

      kLastState = {
        releases: normalizedReleases,
        npmDoc,
        devCommits: devData ? dev.commits : null,
      };

      return {
        ok: true,
        staleAsOf,
        stale: Boolean(
          releasesResult.stale || npmResult.stale || devResult.stale,
        ),
        degraded: {
          github: Boolean(releasesResult.degraded || devResult.degraded),
          // npm data absent altogether is a degradation of the row source
          // even when the fetch itself has not failed yet (cold cache).
          npm: Boolean(npmResult.degraded) || !npmHasVersions,
          githubRateLimited: Boolean(
            releasesResult.rateLimited || devResult.rateLimited,
          ),
        },
        // Per-source freshness for the card's degraded line (v0.9.81).
        sources: {
          github: describeSource(releasesResult, Boolean(rawReleases)),
          npm: describeSource(npmResult, Boolean(npmDoc)),
          dev: describeSource(devResult, Boolean(devData)),
        },
        rowSource,
        distTags,
        stable,
        beta,
        dev,
      };
    } catch (err) {
      warn(`getCatalog failed unexpectedly: ${err?.message || err}`);
      return buildUnavailableCatalog(err?.message);
    }
  };

  const getCatalog = async ({ forceRefresh = false } = {}) => {
    // "Check now" clicks are unmetered from the UI; without a floor a held
    // refresh button burns the anonymous GitHub quota (60/hr) in a minute.
    // The floor used to downgrade a click to a cached read SILENTLY; the
    // result now says what happened (v0.9.81): `refreshed` is true only when
    // this call went to the network on purpose, and a throttled click carries
    // `refreshThrottledForMs` so the card can say "try again in N s".
    let effectiveForce = forceRefresh === true;
    let refreshThrottledForMs = 0;
    if (effectiveForce) {
      const now = nowFn();
      const sinceLast = now - lastForceRefreshAt;
      if (sinceLast < forceRefreshMinIntervalMs) {
        effectiveForce = false;
        refreshThrottledForMs = Math.max(1, forceRefreshMinIntervalMs - sinceLast);
      } else {
        lastForceRefreshAt = now;
      }
    }
    const report = (catalog) => ({
      ...catalog,
      refreshed: effectiveForce,
      ...(refreshThrottledForMs > 0 ? { refreshThrottledForMs } : {}),
    });
    // Concurrent callers share one build; a forced refresh starts its own so
    // it actually hits the network, and late arrivals attach to it.
    if (!effectiveForce && inFlightCatalog) return inFlightCatalog.then(report);
    const promise = computeCatalog(effectiveForce).finally(() => {
      if (inFlightCatalog === promise) inFlightCatalog = null;
    });
    inFlightCatalog = promise;
    return promise.then(report);
  };

  const annotateCatalog = (
    catalog,
    {
      currentId = null,
      lastKnownGood = { package: null, dev: null },
      blocklist = [],
    } = {},
  ) => {
    const copy = JSON.parse(
      JSON.stringify(catalog && typeof catalog === "object" ? catalog : {}),
    );
    const blockEntries = Array.isArray(blocklist) ? blocklist : [];
    const findBlocklisted = (id) => {
      const match = blockEntries.find((entry) => entry && entry.id === id);
      return match
        ? {
            reason: match.reason ?? null,
            at: match.at ?? null,
            exitCode: match.exitCode ?? null,
          }
        : null;
    };
    const annotateReleaseRow = (row) => {
      row.current = Boolean(currentId) && row.version === currentId;
      row.lastKnownGood =
        Boolean(lastKnownGood?.package) && row.version === lastKnownGood.package;
      row.blocklisted = findBlocklisted(row.version);
    };
    for (const row of Array.isArray(copy.stable) ? copy.stable : []) {
      annotateReleaseRow(row);
    }
    for (const row of Array.isArray(copy.beta) ? copy.beta : []) {
      annotateReleaseRow(row);
    }
    const commits = Array.isArray(copy.dev?.commits) ? copy.dev.commits : [];
    for (const commit of commits) {
      commit.current = Boolean(currentId) && commit.sha === currentId;
      commit.lastKnownGood =
        Boolean(lastKnownGood?.dev) && commit.sha === lastKnownGood.dev;
      commit.blocklisted = findBlocklisted(commit.sha);
    }
    return copy;
  };

  const readCachedReleases = () => {
    const cached = readCacheFile(kGithubReleasesCacheFile);
    return Array.isArray(cached?.data)
      ? cached.data.map(normalizeRelease)
      : null;
  };

  const getReleaseNotes = (version) => {
    const target = String(version || "").trim().replace(/^v/, "");
    if (!target) return null;
    const releases = kLastState.releases || readCachedReleases();
    if (!Array.isArray(releases)) return null;
    const match = releases.find((entry) => entry.version === target);
    return match?.notes || null;
  };

  // Membership checks fall back to the disk cache: after a restart (which
  // every apply performs) kLastState is empty until someone loads the catalog,
  // and a direct POST /api/openclaw/apply must not 400 on a valid target.
  const readCachedNpmDoc = () => {
    const cached = readCacheFile(kNpmAbbrevCacheFile);
    return cached?.data && typeof cached.data === "object" ? cached.data : null;
  };

  const readCachedDevCommits = () => {
    const cached = readCacheFile(kDevCommitsCacheFile);
    return Array.isArray(cached?.data?.commits) ? cached.data.commits : null;
  };

  const isKnownVersion = (version, channel = null) => {
    const target = String(version || "").trim().replace(/^v/, "");
    if (!target) return false;
    // A channel-scoped check also pins the classification: a beta version
    // must not be recordable as a "stable" apply (or vice versa).
    if (channel === "stable" && classifyPrerelease(target)) return false;
    if (channel === "beta" && !classifyPrerelease(target)) return false;
    const npmDoc = kLastState.npmDoc || readCachedNpmDoc();
    if (npmDoc) {
      return Object.prototype.hasOwnProperty.call(
        npmDoc.versions || {},
        target,
      );
    }
    const releases = kLastState.releases || readCachedReleases();
    if (Array.isArray(releases)) {
      return releases.some((entry) => entry.version === target);
    }
    return false;
  };

  const isKnownCommit = (sha) => {
    const target = String(sha || "").trim().toLowerCase();
    if (target.length < 7) return false;
    const commits = Array.isArray(kLastState.devCommits)
      ? kLastState.devCommits
      : readCachedDevCommits() || [];
    return commits.some((commit) => {
      const full = String(commit?.sha || "").toLowerCase();
      return full === target || full.startsWith(target);
    });
  };

  return {
    getCatalog,
    annotateCatalog,
    getReleaseNotes,
    isKnownVersion,
    isKnownCommit,
    __awaitRevalidations,
  };
};

module.exports = {
  createOpenclawReleasesService,
  classifyPrerelease,
};
