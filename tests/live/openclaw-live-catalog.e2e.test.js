const fs = require("fs");

const {
  createOpenclawReleasesService,
  classifyPrerelease,
} = require("../../lib/server/openclaw-releases");
const {
  kLiveEnabled,
  kSilentLogger,
  kVersionShape,
  kFullShaShape,
  mkTemp,
  createCountingFetch,
} = require("./live-helpers");

// LIVE TIER 1 — the real catalog against the real GitHub API and the real npm
// registry. Every assertion here encodes an upstream-reality assumption the
// feature depends on; a failure means upstream drifted, not that our code has
// a bug — which is exactly the signal the hermetic suites cannot produce.
//
// Requires: network. Runtime: ~10-30s. Anonymous GitHub quota is 60/hr — set
// GITHUB_TOKEN in CI to avoid 403 flakes.

const describeLive = kLiveEnabled ? describe : describe.skip;

const createLiveService = () => {
  const cacheDir = mkTemp("openclaw-live-catalog-cache-");
  const counting = createCountingFetch();
  const service = createOpenclawReleasesService({
    fetchImpl: counting.fetchImpl,
    cacheDir,
    getGithubToken: () => process.env.GITHUB_TOKEN || null,
    logger: kSilentLogger,
  });
  return { service, cacheDir, counting };
};

describeLive("LIVE openclaw release catalog (real GitHub + npm)", { retry: 1 }, () => {
  it(
    "loads a healthy catalog whose shape matches every assumption the feature encodes",
    { timeout: 90_000 },
    async () => {
      const { service } = createLiveService();
      const catalog = await service.getCatalog({});

      expect(catalog.ok).toBe(true);
      // Degraded = one of the real sources failed. That IS the failure signal.
      // (githubRateLimited is a sub-flag of the github source, false when healthy.)
      expect(catalog.degraded).toEqual({
        github: false,
        npm: false,
        githubRateLimited: false,
      });
      expect(Date.parse(catalog.staleAsOf)).toBeGreaterThan(0);

      // dist-tags: "latest" defines stable; the UI's primary CTA hangs off it.
      expect(typeof catalog.distTags?.latest).toBe("string");
      expect(catalog.distTags.latest).toMatch(kVersionShape);

      // Stable window: exactly 5 rows (upstream has far more than 5 releases),
      // none classified prerelease, dist-tag latest present and badged.
      expect(catalog.stable).toHaveLength(5);
      for (const row of catalog.stable) {
        expect(row.version).toMatch(kVersionShape);
        expect(classifyPrerelease(row.version)).toBe(false);
        expect(Date.parse(row.publishedAt)).toBeGreaterThan(0);
        expect(row.applyPayload).toEqual({
          channel: "stable",
          version: row.version,
        });
      }
      // dist-tag latest USUALLY sits in the 5-row window, but two legit
      // states move it out (a post-incident re-point to an older release; an
      // npm publish that precedes its GitHub release object) — so the badge
      // is asserted only when the row is present, and the npm-doc-backed
      // checks run against a row that certainly exists.
      const latestRow =
        catalog.stable.find((row) => row.isDistTagLatest) || null;
      if (latestRow) {
        expect(latestRow.version).toBe(catalog.distTags.latest);
      }
      expect(service.isKnownVersion(catalog.distTags.latest, "stable")).toBe(
        true,
      );

      // engines from the npm abbreviated doc: the pre-apply Node gate is inert
      // if upstream ever stops publishing engines.
      const enginesRow = latestRow || catalog.stable[0];
      expect(typeof enginesRow.engines?.node).toBe("string");
      expect(enginesRow.engines.node.length).toBeGreaterThan(0);

      // Notes come from GitHub releases; an empty body is a legit upstream
      // state (fresh cut before notes are backfilled) and normalizes to null.
      expect(
        enginesRow.notes === null || typeof enginesRow.notes === "string",
      ).toBe(true);
      expect(enginesRow.notesUnavailable).toBe(false);

      // Beta window: 1-5 prerelease rows, all matching the naming convention
      // the classifier assumes (-beta./-rc./-alpha./-next./-canary.).
      expect(catalog.beta.length).toBeGreaterThanOrEqual(1);
      expect(catalog.beta.length).toBeLessThanOrEqual(5);
      for (const row of catalog.beta) {
        expect(row.version).toMatch(kVersionShape);
        expect(classifyPrerelease(row.version)).toBe(true);
        expect(row.applyPayload).toEqual({
          channel: "beta",
          version: row.version,
        });
      }

      // Dev commits: main-branch window back to the 2nd-newest beta (compare)
      // or the plain listing fallback; full 40-hex shas; capped at 50.
      expect(["compare", "fallback"]).toContain(catalog.dev.source);
      expect(catalog.dev.commits.length).toBeGreaterThanOrEqual(1);
      expect(catalog.dev.commits.length).toBeLessThanOrEqual(50);
      for (const commit of catalog.dev.commits) {
        expect(commit.sha).toMatch(kFullShaShape);
        expect(commit.shortSha).toBe(commit.sha.slice(0, 7));
        expect(typeof commit.subject).toBe("string");
        expect(commit.applyPayload).toEqual({ channel: "dev", sha: commit.sha });
      }
      if (catalog.dev.source === "compare") {
        expect(catalog.dev.baseTag).toMatch(/^v\d/);
      }
    },
  );

  it(
    "answers membership checks against real versions and real commits",
    { timeout: 90_000 },
    async () => {
      const { service } = createLiveService();
      const catalog = await service.getCatalog({});
      expect(catalog.ok).toBe(true);

      const latestStable = catalog.distTags.latest;
      // A GitHub prerelease can precede its npm publish by minutes-to-hours;
      // membership semantics are only meaningful for a beta npm has.
      const newestBeta = catalog.beta
        .map((row) => row.version)
        .find((version) => service.isKnownVersion(version));
      expect(
        newestBeta,
        "no beta in the 5-row window exists on npm — likely a publish gap; " +
          "if persistent, the beta channel's npm assumption drifted",
      ).toBeTruthy();
      const headCommit = catalog.dev.commits[0].sha;

      expect(service.isKnownVersion(latestStable)).toBe(true);
      expect(service.isKnownVersion(latestStable, "stable")).toBe(true);
      // Channel-scoped classification must hold against the REAL version ids.
      expect(service.isKnownVersion(latestStable, "beta")).toBe(false);
      expect(service.isKnownVersion(newestBeta, "beta")).toBe(true);
      expect(service.isKnownVersion(newestBeta, "stable")).toBe(false);
      expect(service.isKnownVersion("9999.99.99")).toBe(false);

      expect(service.isKnownCommit(headCommit)).toBe(true);
      expect(service.isKnownCommit(headCommit.slice(0, 7))).toBe(true);
      expect(service.isKnownCommit("0000000000000000000000000000000000000000")).toBe(
        false,
      );

      // Notes may legitimately be null (empty release body) — assert the
      // lookup agrees with the catalog row rather than demanding content.
      const latestRow = catalog.stable.find(
        (row) => row.version === latestStable,
      );
      if (latestRow) {
        expect(service.getReleaseNotes(latestStable)).toBe(latestRow.notes);
      }
    },
  );

  it(
    "serves the second read from cache without extra network calls, and annotates real rows",
    { timeout: 90_000 },
    async () => {
      const { service, cacheDir, counting } = createLiveService();
      const first = await service.getCatalog({});
      expect(first.ok).toBe(true);
      const callsAfterFirst = counting.calls.length;
      expect(callsAfterFirst).toBeGreaterThanOrEqual(3);
      expect(fs.readdirSync(cacheDir).length).toBeGreaterThanOrEqual(3);

      // Within TTL: zero additional requests.
      const second = await service.getCatalog({});
      expect(second.ok).toBe(true);
      expect(counting.calls.length).toBe(callsAfterFirst);

      // Annotations land on real rows without joins in the client.
      const blockedBeta = second.beta[0].version;
      const annotated = service.annotateCatalog(second, {
        currentId: second.distTags.latest,
        lastKnownGood: { package: second.stable[1]?.version || null, dev: null },
        blocklist: [
          { id: blockedBeta, reason: "crash_loop", exitCode: 1, at: Date.now() },
        ],
      });
      const currentRow = annotated.stable.find((row) => row.current);
      expect(currentRow?.version).toBe(second.distTags.latest);
      const blockedRow = annotated.beta.find((row) => row.blocklisted);
      expect(blockedRow?.version).toBe(blockedBeta);
      expect(blockedRow.blocklisted.reason).toBe("crash_loop");
    },
  );
});
