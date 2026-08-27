const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createOpenclawReleasesService,
  classifyPrerelease,
} = require("../../lib/server/openclaw-releases");
const {
  kOpenclawRegistryUrl,
  kOpenclawGithubApiBaseUrl,
} = require("../../lib/server/constants");

const kNpmAbbreviatedAccept = "application/vnd.npm.install-v1+json";
const kCompareUrlPrefix = `${kOpenclawGithubApiBaseUrl}/compare/`;
const kFallbackCommitsUrl = `${kOpenclawGithubApiBaseUrl}/commits?sha=main&per_page=30`;
const kNow = Date.parse("2026-08-01T00:00:00Z");
const kTtlMs = 10 * 60 * 1000;

const jsonResponse = (body, { status = 200, etag = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name) => (String(name).toLowerCase() === "etag" ? etag : null),
  },
  json: async () => JSON.parse(JSON.stringify(body)),
});

const notModifiedResponse = () => ({
  ok: false,
  status: 304,
  headers: { get: () => null },
  json: async () => {
    throw new Error("304 responses have no body");
  },
});

const release = ({ version, publishedAt, prerelease = false, body }) => ({
  tag_name: `v${version}`,
  published_at: publishedAt,
  prerelease,
  body: body === undefined ? `Notes for ${version}` : body,
});

// Stable hotfix 2026.7.1-2 is the npm dist-tag latest but 2026.6.34 has a
// NEWER published_at — the fixture that separates "latest" from "newest".
const kDefaultReleases = [
  release({ version: "2026.7.2-beta.1", publishedAt: "2026-07-20T00:00:00Z" }),
  release({ version: "2026.6.34", publishedAt: "2026-07-15T00:00:00Z" }),
  release({ version: "2026.7.1-2", publishedAt: "2026-07-10T00:00:00Z" }),
  release({ version: "2026.7.1-beta.3", publishedAt: "2026-07-05T00:00:00Z" }),
  release({ version: "2026.6.30", publishedAt: "2026-06-20T00:00:00Z" }),
];

const kDefaultNpmDoc = {
  "dist-tags": { latest: "2026.7.1-2", beta: "2026.7.2-beta.1" },
  versions: {
    "2026.6.30": { engines: { node: ">=20" } },
    "2026.6.34": { engines: { node: ">=20" } },
    "2026.7.1-2": { engines: { node: ">=22" } },
    "2026.7.1-beta.3": { engines: { node: ">=22" } },
    "2026.7.2-beta.1": { engines: { node: ">=22" } },
  },
};

const buildSha = (index) => String(index).padStart(2, "0").repeat(20);

// GitHub compare returns commits oldest-first; the highest index is newest.
const buildCompareResponse = (count) => ({
  total_commits: count,
  commits: Array.from({ length: count }, (_, index) => ({
    sha: buildSha(index),
    commit: {
      message: `commit ${index}\n\nlonger body ${index}`,
      author: { date: `2026-07-01T00:00:${String(index % 60).padStart(2, "0")}Z` },
    },
  })),
});

// The commits endpoint returns newest-first already.
const buildFallbackCommits = (count) =>
  Array.from({ length: count }, (_, index) => ({
    sha: buildSha(50 + index),
    commit: {
      message: `fallback ${index}`,
      author: { date: `2026-06-30T00:00:${String(index % 60).padStart(2, "0")}Z` },
    },
  }));

const standardHandlers = ({
  releases = kDefaultReleases,
  npmDoc = kDefaultNpmDoc,
  compare = buildCompareResponse(12),
  fallbackCommits = buildFallbackCommits(5),
  etags = {},
} = {}) => [
  ({ url, headers }) => {
    if (!url.startsWith(`${kOpenclawGithubApiBaseUrl}/releases`)) return null;
    if (etags.releases && headers["If-None-Match"] === etags.releases) {
      return notModifiedResponse();
    }
    return jsonResponse(releases, { etag: etags.releases || null });
  },
  ({ url, headers }) => {
    if (url !== kOpenclawRegistryUrl) return null;
    if (etags.npm && headers["If-None-Match"] === etags.npm) {
      return notModifiedResponse();
    }
    return jsonResponse(npmDoc, { etag: etags.npm || null });
  },
  ({ url, headers }) => {
    if (!url.startsWith(kCompareUrlPrefix)) return null;
    if (!compare) return jsonResponse({ message: "Not Found" }, { status: 404 });
    if (etags.compare && headers["If-None-Match"] === etags.compare) {
      return notModifiedResponse();
    }
    return jsonResponse(compare, { etag: etags.compare || null });
  },
  ({ url }) => {
    if (!url.startsWith(`${kOpenclawGithubApiBaseUrl}/commits`)) return null;
    return jsonResponse(fallbackCommits, { etag: null });
  },
];

const failingGithubHandler = (status = 403) => ({ url }) =>
  url.startsWith(kOpenclawGithubApiBaseUrl)
    ? jsonResponse({ message: "API rate limit exceeded" }, { status })
    : null;

const npmOnlyHandler = (npmDoc = kDefaultNpmDoc) => ({ url }) =>
  url === kOpenclawRegistryUrl ? jsonResponse(npmDoc) : null;

const createHarness = ({
  handlers = standardHandlers(),
  now = kNow,
  cacheTtlMs = kTtlMs,
  getGithubToken,
} = {}) => {
  const cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "openclaw-releases-test-"),
  );
  const calls = [];
  const state = { now, handlers };
  const fetchImpl = vi.fn(async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    calls.push({ url, headers });
    for (const handler of state.handlers) {
      const response = handler({ url, headers });
      if (response) return response;
    }
    throw new Error(`Unrouted fetch: ${url}`);
  });
  const service = createOpenclawReleasesService({
    fetchImpl,
    cacheDir,
    cacheTtlMs,
    nowFn: () => state.now,
    ...(getGithubToken ? { getGithubToken } : {}),
    logger: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  });
  return { service, fetchImpl, calls, cacheDir, state };
};

describe("server/openclaw-releases", () => {
  describe("classifyPrerelease", () => {
    it("classifies named channel suffixes as prerelease", () => {
      expect(classifyPrerelease("2026.7.2-beta.1")).toBe(true);
      expect(classifyPrerelease("2026.7.2-alpha.4")).toBe(true);
      expect(classifyPrerelease("2026.7.2-rc.1")).toBe(true);
      expect(classifyPrerelease("2026.7.2-next.20260720")).toBe(true);
      expect(classifyPrerelease("2026.7.2-canary.3")).toBe(true);
      expect(classifyPrerelease("2026.7.2-BETA.1")).toBe(true);
    });

    it("treats bare numeric hotfix suffixes and plain versions as stable", () => {
      expect(classifyPrerelease("2026.7.1-2")).toBe(false);
      expect(classifyPrerelease("2026.6.34")).toBe(false);
      expect(classifyPrerelease("")).toBe(false);
      expect(classifyPrerelease(null)).toBe(false);
    });
  });

  describe("getCatalog", () => {
    it("keeps rows date-sorted while the dist-tag decides isDistTagLatest", async () => {
      const { service } = createHarness();

      const catalog = await service.getCatalog();

      expect(catalog.ok).toBe(true);
      expect(catalog.degraded).toEqual({ github: false, npm: false });
      expect(catalog.distTags).toEqual({
        latest: "2026.7.1-2",
        beta: "2026.7.2-beta.1",
      });
      // 2026.6.34 was published after the 2026.7.1-2 hotfix → it sorts first,
      // but only the dist-tag latest is flagged.
      expect(catalog.stable.map((row) => row.version)).toEqual([
        "2026.6.34",
        "2026.7.1-2",
        "2026.6.30",
      ]);
      expect(catalog.stable.map((row) => row.isDistTagLatest)).toEqual([
        false,
        true,
        false,
      ]);
      expect(catalog.beta.map((row) => row.version)).toEqual([
        "2026.7.2-beta.1",
        "2026.7.1-beta.3",
      ]);
      expect(catalog.stable[1]).toEqual({
        version: "2026.7.1-2",
        publishedAt: "2026-07-10T00:00:00Z",
        prerelease: false,
        isDistTagLatest: true,
        engines: { node: ">=22" },
        notes: "Notes for 2026.7.1-2",
        notesUnavailable: false,
        applyPayload: { channel: "stable", version: "2026.7.1-2" },
      });
      expect(catalog.beta[0].applyPayload).toEqual({
        channel: "beta",
        version: "2026.7.2-beta.1",
      });
    });

    it("caps the stable and beta windows at five rows each", async () => {
      const releases = [];
      for (let i = 0; i < 10; i += 1) {
        releases.push(
          release({
            version: `2026.5.${i}`,
            publishedAt: `2026-05-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
          }),
        );
      }
      for (let i = 0; i < 9; i += 1) {
        releases.push(
          release({
            version: `2026.6.0-beta.${i}`,
            publishedAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
          }),
        );
      }
      // GitHub prerelease flag without a channel suffix still counts as beta.
      releases.push(
        release({
          version: "2026.6.1",
          publishedAt: "2026-06-15T00:00:00Z",
          prerelease: true,
        }),
      );
      const { service } = createHarness({
        handlers: standardHandlers({ releases }),
      });

      const catalog = await service.getCatalog();

      expect(catalog.stable).toHaveLength(5);
      expect(catalog.beta).toHaveLength(5);
      expect(catalog.stable.map((row) => row.version)).toEqual([
        "2026.5.9",
        "2026.5.8",
        "2026.5.7",
        "2026.5.6",
        "2026.5.5",
      ]);
      expect(catalog.beta.map((row) => row.version)).toEqual([
        "2026.6.1",
        "2026.6.0-beta.8",
        "2026.6.0-beta.7",
        "2026.6.0-beta.6",
        "2026.6.0-beta.5",
      ]);
      expect(catalog.beta[0].prerelease).toBe(true);
    });

    it("returns short windows without padding", async () => {
      const releases = [
        release({ version: "2026.4.2", publishedAt: "2026-04-20T00:00:00Z" }),
        release({
          version: "2026.4.2-beta.1",
          publishedAt: "2026-04-15T00:00:00Z",
        }),
        release({ version: "2026.4.1", publishedAt: "2026-04-10T00:00:00Z" }),
      ];
      const { service } = createHarness({
        handlers: standardHandlers({
          releases,
          fallbackCommits: buildFallbackCommits(3),
        }),
      });

      const catalog = await service.getCatalog();

      expect(catalog.ok).toBe(true);
      expect(catalog.stable.map((row) => row.version)).toEqual([
        "2026.4.2",
        "2026.4.1",
      ]);
      expect(catalog.beta.map((row) => row.version)).toEqual([
        "2026.4.2-beta.1",
      ]);
      // Only one beta exists → no base tag → dev falls back to plain commits.
      expect(catalog.dev.source).toBe("fallback");
      expect(catalog.dev.baseTag).toBe(null);
      expect(catalog.dev.commits).toHaveLength(3);
    });

    it("builds dev commits from compare newest-first with a cap of 50", async () => {
      const { service, calls } = createHarness({
        handlers: standardHandlers({ compare: buildCompareResponse(60) }),
      });

      const catalog = await service.getCatalog();

      // Base tag is the SECOND newest beta with the "v" prefix restored.
      expect(
        calls.some(
          (call) =>
            call.url ===
            `${kOpenclawGithubApiBaseUrl}/compare/v2026.7.1-beta.3...main?per_page=250`,
        ),
      ).toBe(true);
      expect(catalog.dev.source).toBe("compare");
      expect(catalog.dev.baseTag).toBe("v2026.7.1-beta.3");
      expect(catalog.dev.truncated).toBe(true);
      expect(catalog.dev.commits).toHaveLength(50);
      expect(catalog.dev.commits[0]).toEqual({
        sha: buildSha(59),
        shortSha: buildSha(59).slice(0, 7),
        subject: "commit 59",
        date: "2026-07-01T00:00:59Z",
        applyPayload: { channel: "dev", sha: buildSha(59) },
      });
      expect(catalog.dev.commits[49].sha).toBe(buildSha(10));
      expect(catalog.dev.commits[0].shortSha).toHaveLength(7);
    });

    it("uses the fallback commits endpoint when compare returns 404", async () => {
      const fallbackCommits = buildFallbackCommits(30);
      const { service, calls } = createHarness({
        handlers: standardHandlers({ compare: null, fallbackCommits }),
      });

      const catalog = await service.getCatalog();

      expect(calls.some((call) => call.url === kFallbackCommitsUrl)).toBe(true);
      expect(catalog.dev.source).toBe("fallback");
      expect(catalog.dev.baseTag).toBe(null);
      expect(catalog.dev.truncated).toBe(false);
      expect(catalog.dev.commits).toHaveLength(30);
      // Already newest-first — the order is preserved, not reversed.
      expect(catalog.dev.commits[0].sha).toBe(fallbackCommits[0].sha);
      expect(catalog.dev.commits[0].subject).toBe("fallback 0");
      expect(catalog.dev.commits[0].applyPayload).toEqual({
        channel: "dev",
        sha: fallbackCommits[0].sha,
      });
    });

    it("only ever requests npm with the abbreviated Accept header and extracts engines", async () => {
      const { service, calls } = createHarness();

      const catalog = await service.getCatalog();
      await service.getCatalog({ forceRefresh: true });

      const npmCalls = calls.filter((call) => call.url === kOpenclawRegistryUrl);
      expect(npmCalls.length).toBeGreaterThan(1);
      for (const call of npmCalls) {
        expect(call.headers.Accept).toBe(kNpmAbbreviatedAccept);
      }
      // No request ever hit the npm URL without the abbreviated Accept header.
      expect(
        calls.filter(
          (call) =>
            call.url === kOpenclawRegistryUrl &&
            call.headers.Accept !== kNpmAbbreviatedAccept,
        ),
      ).toEqual([]);
      expect(
        catalog.stable.find((row) => row.version === "2026.6.34").engines,
      ).toEqual({ node: ">=20" });
      expect(
        catalog.beta.find((row) => row.version === "2026.7.2-beta.1").engines,
      ).toEqual({ node: ">=22" });
    });

    it("serves from disk within the TTL and revalidates with If-None-Match after it", async () => {
      const etags = {
        releases: 'W/"rel-1"',
        npm: '"npm-1"',
        compare: 'W/"cmp-1"',
      };
      const { service, fetchImpl, calls, cacheDir, state } = createHarness({
        handlers: standardHandlers({ etags }),
      });

      const first = await service.getCatalog();
      expect(first.staleAsOf).toBe(new Date(kNow).toISOString());
      expect(fs.existsSync(path.join(cacheDir, "github-releases.json"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(cacheDir, "npm-abbrev.json"))).toBe(true);
      expect(fs.existsSync(path.join(cacheDir, "dev-commits.json"))).toBe(true);
      const callsAfterFirst = fetchImpl.mock.calls.length;
      expect(callsAfterFirst).toBe(3);

      // Second call inside the TTL: served from disk, zero fetches.
      state.now = kNow + kTtlMs - 1000;
      const second = await service.getCatalog();
      expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
      expect(second.staleAsOf).toBe(new Date(kNow).toISOString());
      expect(second.stable).toEqual(first.stable);
      expect(second.dev).toEqual(first.dev);

      // Third call after the TTL: revalidates with If-None-Match, 304 → cached
      // data is reused and fetchedAt (→ staleAsOf) advances.
      state.now = kNow + kTtlMs + 1000;
      const third = await service.getCatalog();
      expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst + 3);
      const revalidations = calls.slice(callsAfterFirst);
      expect(
        revalidations.find((call) =>
          call.url.startsWith(`${kOpenclawGithubApiBaseUrl}/releases`),
        ).headers["If-None-Match"],
      ).toBe(etags.releases);
      expect(
        revalidations.find((call) => call.url === kOpenclawRegistryUrl).headers[
          "If-None-Match"
        ],
      ).toBe(etags.npm);
      expect(
        revalidations.find((call) => call.url.startsWith(kCompareUrlPrefix))
          .headers["If-None-Match"],
      ).toBe(etags.compare);
      expect(third.ok).toBe(true);
      expect(third.degraded).toEqual({ github: false, npm: false });
      expect(third.stable).toEqual(first.stable);
      expect(third.dev).toEqual(first.dev);
      expect(third.staleAsOf).toBe(new Date(kNow + kTtlMs + 1000).toISOString());
    });

    it("forceRefresh bypasses the TTL but still sends If-None-Match", async () => {
      const etags = {
        releases: 'W/"rel-2"',
        npm: '"npm-2"',
        compare: 'W/"cmp-2"',
      };
      const { service, fetchImpl, calls } = createHarness({
        handlers: standardHandlers({ etags }),
      });

      const first = await service.getCatalog();
      const callsAfterFirst = fetchImpl.mock.calls.length;

      const refreshed = await service.getCatalog({ forceRefresh: true });

      expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst + 3);
      for (const call of calls.slice(callsAfterFirst)) {
        expect(call.headers["If-None-Match"]).toBeTruthy();
      }
      expect(refreshed.ok).toBe(true);
      expect(refreshed.stable).toEqual(first.stable);
      expect(refreshed.beta).toEqual(first.beta);
      expect(refreshed.dev).toEqual(first.dev);
    });

    it("degrades to npm-only rows when GitHub fails with a cold cache", async () => {
      const { service } = createHarness({
        handlers: [failingGithubHandler(403), npmOnlyHandler()],
      });

      const catalog = await service.getCatalog();

      expect(catalog.ok).toBe(true);
      expect(catalog.degraded).toEqual({ github: true, npm: false });
      expect(catalog.distTags).toEqual({
        latest: "2026.7.1-2",
        beta: "2026.7.2-beta.1",
      });
      expect(catalog.stable.map((row) => row.version)).toEqual([
        "2026.7.1-2",
        "2026.6.34",
        "2026.6.30",
      ]);
      expect(catalog.beta.map((row) => row.version)).toEqual([
        "2026.7.2-beta.1",
        "2026.7.1-beta.3",
      ]);
      for (const row of [...catalog.stable, ...catalog.beta]) {
        expect(row.notesUnavailable).toBe(true);
        expect(row.notes).toBe(null);
        expect(row.publishedAt).toBe(null);
      }
      expect(catalog.stable[0].isDistTagLatest).toBe(true);
      expect(catalog.stable[0].engines).toEqual({ node: ">=22" });
      expect(catalog.dev).toEqual({
        commits: [],
        truncated: false,
        baseTag: null,
        source: null,
      });
    });

    it("uses the stale GitHub cache when GitHub fails after a warm fetch", async () => {
      const { service, state } = createHarness();
      const first = await service.getCatalog();

      state.now = kNow + kTtlMs + 1000;
      state.handlers = [failingGithubHandler(403), npmOnlyHandler()];
      const second = await service.getCatalog();

      expect(second.ok).toBe(true);
      expect(second.degraded).toEqual({ github: true, npm: false });
      // GitHub-backed rows survive from the stale cache — notes intact.
      expect(second.stable).toEqual(first.stable);
      expect(second.beta).toEqual(first.beta);
      expect(second.stable[1].notes).toBe("Notes for 2026.7.1-2");
      expect(second.stable[1].notesUnavailable).toBe(false);
      expect(second.dev).toEqual(first.dev);
      // staleAsOf is the oldest source used: the stale GitHub fetch time.
      expect(second.staleAsOf).toBe(new Date(kNow).toISOString());
    });

    it("degrades npm without losing GitHub rows", async () => {
      const githubHandlers = standardHandlers();
      const { service } = createHarness({
        handlers: [
          ({ url }) => {
            if (url === kOpenclawRegistryUrl) throw new Error("npm timeout");
            return null;
          },
          ...githubHandlers,
        ],
      });

      const catalog = await service.getCatalog();

      expect(catalog.ok).toBe(true);
      expect(catalog.degraded).toEqual({ github: false, npm: true });
      expect(catalog.distTags).toBe(null);
      expect(catalog.stable.map((row) => row.version)).toEqual([
        "2026.6.34",
        "2026.7.1-2",
        "2026.6.30",
      ]);
      for (const row of [...catalog.stable, ...catalog.beta]) {
        expect(row.engines).toBe(null);
        expect(row.isDistTagLatest).toBe(false);
      }
      expect(catalog.stable[0].notes).toBe("Notes for 2026.6.34");
    });

    it("resolves catalog_unavailable when both sources fail with a cold cache", async () => {
      const { service } = createHarness({
        handlers: [() => jsonResponse({ message: "boom" }, { status: 500 })],
      });

      await expect(service.getCatalog()).resolves.toEqual(
        expect.objectContaining({
          ok: false,
          code: "catalog_unavailable",
          docsUrl: null,
          degraded: { github: true, npm: true },
          staleAsOf: null,
          distTags: null,
          stable: [],
          beta: [],
          dev: { commits: [], truncated: false, baseTag: null, source: null },
        }),
      );
      const catalog = await service.getCatalog();
      expect(typeof catalog.message).toBe("string");
      expect(catalog.message.length).toBeGreaterThan(0);
      expect(typeof catalog.hint).toBe("string");
      expect(catalog.hint.length).toBeGreaterThan(0);
    });

    it("sends the GitHub token to GitHub only", async () => {
      const { service, calls } = createHarness({
        getGithubToken: () => "tok",
      });

      await service.getCatalog();

      const githubCalls = calls.filter((call) =>
        call.url.startsWith(kOpenclawGithubApiBaseUrl),
      );
      expect(githubCalls.length).toBeGreaterThan(0);
      for (const call of githubCalls) {
        expect(call.headers.Authorization).toBe("Bearer tok");
      }
      const npmCalls = calls.filter((call) => call.url === kOpenclawRegistryUrl);
      expect(npmCalls.length).toBeGreaterThan(0);
      for (const call of npmCalls) {
        expect(call.headers.Authorization).toBeUndefined();
      }
    });
  });

  describe("annotateCatalog and membership", () => {
    it("annotates rows and commits without mutating the input", async () => {
      const { service } = createHarness({
        handlers: standardHandlers({ compare: buildCompareResponse(12) }),
      });
      const catalog = await service.getCatalog();
      const snapshot = JSON.parse(JSON.stringify(catalog));
      const newestSha = buildSha(11);
      const olderSha = buildSha(10);

      const annotated = service.annotateCatalog(catalog, {
        currentId: "2026.7.1-2",
        lastKnownGood: { package: "2026.6.34", dev: olderSha },
        blocklist: [
          {
            id: "2026.6.30",
            reason: "crash loop",
            exitCode: 137,
            at: "2026-07-30T00:00:00Z",
          },
          {
            id: newestSha,
            reason: "boot failure",
            exitCode: 1,
            at: "2026-07-31T00:00:00Z",
          },
        ],
      });

      const currentRow = annotated.stable.find(
        (row) => row.version === "2026.7.1-2",
      );
      expect(currentRow.current).toBe(true);
      expect(currentRow.lastKnownGood).toBe(false);
      expect(currentRow.blocklisted).toBe(null);
      const lkgRow = annotated.stable.find(
        (row) => row.version === "2026.6.34",
      );
      expect(lkgRow.current).toBe(false);
      expect(lkgRow.lastKnownGood).toBe(true);
      const blockedRow = annotated.stable.find(
        (row) => row.version === "2026.6.30",
      );
      expect(blockedRow.blocklisted).toEqual({
        reason: "crash loop",
        at: "2026-07-30T00:00:00Z",
        exitCode: 137,
      });
      expect(annotated.beta[0].current).toBe(false);
      expect(annotated.beta[0].lastKnownGood).toBe(false);
      expect(annotated.beta[0].blocklisted).toBe(null);
      const blockedCommit = annotated.dev.commits.find(
        (commit) => commit.sha === newestSha,
      );
      expect(blockedCommit.blocklisted).toEqual({
        reason: "boot failure",
        at: "2026-07-31T00:00:00Z",
        exitCode: 1,
      });
      expect(blockedCommit.current).toBe(false);
      const lkgCommit = annotated.dev.commits.find(
        (commit) => commit.sha === olderSha,
      );
      expect(lkgCommit.lastKnownGood).toBe(true);
      expect(lkgCommit.blocklisted).toBe(null);
      // The input catalog is untouched.
      expect(catalog).toEqual(snapshot);
      expect(catalog.stable[0]).not.toHaveProperty("current");
      expect(catalog.dev.commits[0]).not.toHaveProperty("blocklisted");
    });

    it("tracks known versions and commits from the last catalog", async () => {
      const { service } = createHarness({
        handlers: standardHandlers({ compare: buildCompareResponse(12) }),
      });
      await service.getCatalog();
      const newestSha = buildSha(11);

      expect(service.isKnownVersion("2026.7.1-2")).toBe(true);
      expect(service.isKnownVersion("2026.7.2-beta.1")).toBe(true);
      expect(service.isKnownVersion("9999.0.0")).toBe(false);
      expect(service.isKnownCommit(newestSha)).toBe(true);
      expect(service.isKnownCommit(newestSha.slice(0, 7))).toBe(true);
      expect(service.isKnownCommit(newestSha.slice(0, 6))).toBe(false);
      expect(service.isKnownCommit("deadbeefdeadbeef")).toBe(false);
    });

    it("returns release notes from the cached GitHub data", async () => {
      const { service } = createHarness();
      await service.getCatalog();

      expect(service.getReleaseNotes("2026.7.1-2")).toBe(
        "Notes for 2026.7.1-2",
      );
      expect(service.getReleaseNotes("v2026.6.34")).toBe(
        "Notes for 2026.6.34",
      );
      expect(service.getReleaseNotes("0.0.0")).toBe(null);
    });

    it("reports unknown before any catalog fetch", () => {
      const { service } = createHarness({ handlers: [] });

      expect(service.isKnownVersion("2026.7.1-2")).toBe(false);
      expect(service.isKnownCommit(buildSha(1))).toBe(false);
      expect(service.getReleaseNotes("2026.7.1-2")).toBe(null);
    });

    it("answers membership and notes from the disk cache after a restart, with zero fetches", async () => {
      // Every apply restarts the server, so the first POST /api/openclaw/apply
      // afterwards hits a fresh service whose in-memory state is empty. It must
      // answer from the disk cache instead of 400-ing on a valid target.
      const warm = createHarness({
        handlers: standardHandlers({ compare: buildCompareResponse(12) }),
      });
      await warm.service.getCatalog();

      const offlineFetch = vi.fn(async (url) => {
        throw new Error(`network must not be touched: ${url}`);
      });
      const restarted = createOpenclawReleasesService({
        fetchImpl: offlineFetch,
        cacheDir: warm.cacheDir,
        cacheTtlMs: kTtlMs,
        nowFn: () => kNow,
        logger: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
      });

      expect(restarted.isKnownVersion("2026.7.1-2")).toBe(true);
      expect(restarted.isKnownVersion("2026.7.2-beta.1", "beta")).toBe(true);
      expect(restarted.isKnownVersion("9999.0.0")).toBe(false);
      expect(restarted.isKnownCommit(buildSha(11))).toBe(true);
      expect(restarted.isKnownCommit(buildSha(11).slice(0, 7))).toBe(true);
      expect(restarted.getReleaseNotes("2026.7.1-2")).toBe(
        "Notes for 2026.7.1-2",
      );
      expect(offlineFetch).not.toHaveBeenCalled();
    });

    it("pins the classification when the membership check is channel-scoped", async () => {
      const { service } = createHarness();
      await service.getCatalog();

      // A published beta must not be recordable as a "stable" apply and vice
      // versa — the recorded channel has to match the artifact.
      expect(service.isKnownVersion("2026.7.2-beta.1", "beta")).toBe(true);
      expect(service.isKnownVersion("2026.7.2-beta.1", "stable")).toBe(false);
      // Numeric hotfix suffixes are stable releases, not prereleases.
      expect(service.isKnownVersion("2026.7.1-2", "stable")).toBe(true);
      expect(service.isKnownVersion("2026.7.1-2", "beta")).toBe(false);
      // Unscoped checks keep the channel-agnostic behavior.
      expect(service.isKnownVersion("2026.7.2-beta.1")).toBe(true);
    });
  });
});
