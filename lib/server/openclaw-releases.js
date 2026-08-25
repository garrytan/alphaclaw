const fs = require("fs");
const path = require("path");
const {
  kOpenclawRegistryUrl,
  kOpenclawGithubApiBaseUrl,
  kOpenclawCatalogCacheDir,
  kOpenclawCatalogCacheTtlMs,
  kOpenclawStableCatalogCount,
  kOpenclawBetaCatalogCount,
  kOpenclawDevCommitCap,
  kOpenclawDevCommitFallbackCount,
} = require("./constants");

const kGithubReleasesCacheFile = "github-releases.json";
const kNpmAbbrevCacheFile = "npm-abbrev.json";
const kDevCommitsCacheFile = "dev-commits.json";
// The full npm registry doc for openclaw is MB-scale; the abbreviated
// install doc carries everything the catalog needs (dist-tags + engines).
const kNpmAbbreviatedAccept = "application/vnd.npm.install-v1+json";
const kGithubAccept = "application/vnd.github+json";
const kUserAgent = "alphaclaw";
const kForceRefreshMinIntervalMs = 30_000;
// Bare numeric hotfix suffixes like "2026.7.1-2" are stable hotfixes, not
// prereleases — only named channels with a dotted counter classify as beta.
const kPrereleasePattern = /-(beta|alpha|rc|next|canary)\./i;

const classifyPrerelease = (version) =>
  kPrereleasePattern.test(String(version || ""));

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
  };

  // A 304 only proves freshness — update the memo's fetchedAt instead of
  // rewriting the MB-scale blob to disk; worst case after a restart is one
  // extra conditional request answered by another 304.
  const touchCacheFile = (name, entry, fetchedAt) => {
    memoCache.set(name, { ...entry, fetchedAt });
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

  // Shared disk-cache flow: fresh within TTL → no fetch; otherwise fetch with
  // If-None-Match, honoring 304s; on failure fall back to stale cache data.
  const loadSource = async ({ cacheFile, forceRefresh, doFetch, label }) => {
    const cached = readCacheFile(cacheFile);
    const now = nowFn();
    if (cached && !forceRefresh && now - cached.fetchedAt < cacheTtlMs) {
      return { data: cached.data, fetchedAt: cached.fetchedAt, degraded: false };
    }
    try {
      const result = await doFetch({ cached });
      if (result.notModified) {
        if (!cached) {
          throw new Error(`${label} returned 304 without a cached copy`);
        }
        touchCacheFile(cacheFile, cached, now);
        return { data: cached.data, fetchedAt: now, degraded: false };
      }
      writeCacheFile(cacheFile, {
        etag: result.etag || null,
        fetchedAt: now,
        data: result.data,
      });
      return { data: result.data, fetchedAt: now, degraded: false };
    } catch (err) {
      warn(`${label} fetch failed: ${err?.message || err}`);
      if (cached) {
        // Better stale than nothing — surface the cache, flagged degraded.
        return { data: cached.data, fetchedAt: cached.fetchedAt, degraded: true };
      }
      return { data: null, fetchedAt: null, degraded: true };
    }
  };

  const fetchGithubReleases = async ({ cached }) => {
    const firstPageUrl = `${kOpenclawGithubApiBaseUrl}/releases?per_page=100`;
    const response = await fetchImpl(firstPageUrl, {
      headers: githubHeaders({ etag: cached?.etag || null }),
    });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) {
      throw new Error(`GitHub releases request failed (${response.status})`);
    }
    const firstPage = await response.json();
    let releases = Array.isArray(firstPage) ? firstPage : [];
    if (releases.length === 100) {
      try {
        const nextResponse = await fetchImpl(`${firstPageUrl}&page=2`, {
          headers: githubHeaders(),
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
    });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) {
      throw new Error(`npm registry request failed (${response.status})`);
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
        throw new Error(`GitHub compare request failed (${response.status})`);
      }
      // 404 (e.g. tag deleted) → fall through to the plain commits listing.
    }
    const fallbackUrl = `${kOpenclawGithubApiBaseUrl}/commits?sha=main&per_page=${kOpenclawDevCommitFallbackCount}`;
    const etag = cached?.data?.url === fallbackUrl ? cached?.etag || null : null;
    const response = await fetchImpl(fallbackUrl, {
      headers: githubHeaders({ etag }),
    });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) {
      throw new Error(`GitHub commits request failed (${response.status})`);
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

  // npm-only fallback rows for when GitHub is degraded with no cache: the
  // abbreviated doc lists versions in publish order, so reversing the keys
  // yields newest-first. No release metadata → notesUnavailable on every row.
  const buildNpmOnlyEntries = (npmDoc) => {
    const versions = Object.keys(npmDoc?.versions || {});
    const seen = new Set(versions);
    const ordered = versions.slice().reverse();
    for (const target of Object.values(npmDoc?.distTags || {})) {
      const version = String(target || "");
      if (version && !seen.has(version)) {
        seen.add(version);
        ordered.unshift(version);
      }
    }
    return ordered.map((version) => ({
      version,
      publishedAt: null,
      notes: null,
      prerelease: classifyPrerelease(version),
      notesUnavailable: true,
    }));
  };

  const buildUnavailableCatalog = (message) => ({
    ok: false,
    code: "catalog_unavailable",
    message:
      String(message || "").trim() ||
      "Could not load the OpenClaw release catalog from GitHub or npm.",
    hint: "Check the server's network access (and GITHUB_TOKEN if configured), then refresh the catalog.",
    docsUrl: null,
    degraded: { github: true, npm: true },
    staleAsOf: null,
    distTags: null,
    stable: [],
    beta: [],
    dev: { commits: [], truncated: false, baseTag: null, source: null },
  });

  let lastForceRefreshAt = 0;

  const getCatalog = async ({ forceRefresh = false } = {}) => {
    // "Check now" clicks are unmetered from the UI; without a floor a held
    // refresh button burns the anonymous GitHub quota (60/hr) in a minute.
    let effectiveForce = forceRefresh === true;
    if (effectiveForce) {
      const now = nowFn();
      if (now - lastForceRefreshAt < kForceRefreshMinIntervalMs) {
        effectiveForce = false;
      } else {
        lastForceRefreshAt = now;
      }
    }
    try {
      const [releasesResult, npmResult] = await Promise.all([
        loadSource({
          cacheFile: kGithubReleasesCacheFile,
          forceRefresh: effectiveForce,
          doFetch: fetchGithubReleases,
          label: "GitHub releases",
        }),
        loadSource({
          cacheFile: kNpmAbbrevCacheFile,
          forceRefresh: effectiveForce,
          doFetch: fetchNpmAbbrevDoc,
          label: "npm registry",
        }),
      ]);
      const rawReleases = Array.isArray(releasesResult.data)
        ? releasesResult.data
        : null;
      const npmDoc = npmResult.data || null;

      if (!rawReleases && !npmDoc) {
        return buildUnavailableCatalog();
      }

      const normalizedReleases = rawReleases
        ? rawReleases.map(normalizeRelease).sort(byPublishedAtDesc)
        : null;

      const devResult = await loadSource({
        cacheFile: kDevCommitsCacheFile,
        forceRefresh: effectiveForce,
        doFetch: createDevCommitsFetcher({
          baseTag: resolveDevBaseTag(normalizedReleases),
        }),
        label: "GitHub dev commits",
      });
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

      const entries = normalizedReleases || buildNpmOnlyEntries(npmDoc);
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

      const fetchedAts = [];
      if (rawReleases && Number.isFinite(releasesResult.fetchedAt)) {
        fetchedAts.push(releasesResult.fetchedAt);
      }
      if (npmDoc && Number.isFinite(npmResult.fetchedAt)) {
        fetchedAts.push(npmResult.fetchedAt);
      }
      if (devData && Number.isFinite(devResult.fetchedAt)) {
        fetchedAts.push(devResult.fetchedAt);
      }
      const staleAsOf = fetchedAts.length
        ? new Date(Math.min(...fetchedAts)).toISOString()
        : null;

      kLastState = {
        releases: normalizedReleases,
        npmDoc,
        devCommits: devData ? dev.commits : null,
      };

      return {
        ok: true,
        staleAsOf,
        degraded: {
          github: Boolean(releasesResult.degraded || devResult.degraded),
          npm: Boolean(npmResult.degraded),
        },
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
  };
};

module.exports = {
  createOpenclawReleasesService,
  classifyPrerelease,
};
