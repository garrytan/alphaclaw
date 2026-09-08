const { resolveUpgradeJourney } = require('../container/container-helpers');

const registry = (extra = {}) => ({
  distTags: { latest: '2026.9.3', beta: '2026.9.1' },
  versions: Object.fromEntries(['2026.7.1-2', '2026.9.1-beta.1', '2026.9.1', '2026.9.2', '2026.9.3'].map(v => [v, {}])),
  stablePin: '2026.9.2',
  ...extra,
});

describe('container upgrade journey admission', () => {
  it('runs an explicit historical upgrade when no newer beta exists above the shipped pin', () => {
    expect(resolveUpgradeJourney(registry())).toMatchObject({
      stable: '2026.7.1-2', beta: '2026.9.1-beta.1', source: 'historical-reference',
    });
  });

  it('uses the shipped pin when a published newer prerelease exists', () => {
    const input = registry();
    input.versions['2026.9.4-beta.1'] = {};
    input.distTags.beta = '2026.9.4-beta.1';
    expect(resolveUpgradeJourney(input)).toMatchObject({
      stable: '2026.9.2', beta: '2026.9.4-beta.1', source: 'dist-tag',
    });
  });

  it('also exercises the historical journey when the shipped pin is current', () => {
    const input = registry();
    input.distTags.latest = input.stablePin;
    expect(resolveUpgradeJourney(input).source).toBe('historical-reference');
  });

  it.each(['2026.7.1-2', '2026.9.1-beta.1', '2026.9.2', '2026.9.3', '2026.9.1'])(
    'refuses missing required published package %s instead of silently skipping', (version) => {
      const input = registry();
      delete input.versions[version];
      expect(() => resolveUpgradeJourney(input)).toThrow(/published/);
    },
  );

  it('refuses deprecated historical fixtures', () => {
    const input = registry();
    input.versions['2026.9.1-beta.1'].deprecated = 'broken release';
    expect(() => resolveUpgradeJourney(input)).toThrow(/deprecated/);
  });

  it('refuses an unpublished newer tagged beta', () => {
    const input = registry();
    input.distTags.beta = '2026.9.4-beta.1';
    expect(() => resolveUpgradeJourney(input)).toThrow(/published/);
  });
});
