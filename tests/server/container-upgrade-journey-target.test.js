const { resolveUpgradeJourney } = require('../container/container-helpers');

const registry = (extra = {}) => ({
  distTags: { latest: '2026.9.3', beta: '2026.9.1' },
  versions: Object.fromEntries(['2026.7.1-2', '2026.9.1-beta.1', '2026.9.1', '2026.9.2', '2026.9.3'].map(v => [v, {}])),
  stablePin: '2026.9.2',
  ...extra,
});

describe('container upgrade journey admission', () => {
  it('upgrades the historical stable to the SHIPPED PIN when no newer beta exists above it', () => {
    // A beta gap must never fall back to a fixed historical prerelease: the
    // old target 2026.9.1-beta.1 stopped booting when its bundled plugin
    // started requiring plugin API >= 2026.9.3. The pin is the newest build
    // we ship, and 2026.7.1-2's schema 1 still exercises the migration spine.
    expect(resolveUpgradeJourney(registry())).toMatchObject({
      stable: '2026.7.1-2', beta: '2026.9.2', targetChannel: 'stable', source: 'stable-pin',
    });
  });

  it('uses the shipped pin as the SOURCE when a published newer prerelease exists', () => {
    const input = registry();
    input.versions['2026.9.4-beta.1'] = {};
    input.distTags.beta = '2026.9.4-beta.1';
    expect(resolveUpgradeJourney(input)).toMatchObject({
      stable: '2026.9.2', beta: '2026.9.4-beta.1', targetChannel: 'beta', source: 'dist-tag',
    });
  });

  it('also runs the stable→pin journey when the shipped pin is current', () => {
    const input = registry();
    input.distTags.latest = input.stablePin;
    expect(resolveUpgradeJourney(input)).toMatchObject({ targetChannel: 'stable', source: 'stable-pin' });
  });

  it('never depends on the retired historical prerelease being published', () => {
    const input = registry();
    delete input.versions['2026.9.1-beta.1'];
    expect(resolveUpgradeJourney(input).source).toBe('stable-pin');
  });

  it.each(['2026.7.1-2', '2026.9.2', '2026.9.3', '2026.9.1'])(
    'refuses missing required published package %s instead of silently skipping', (version) => {
      const input = registry();
      delete input.versions[version];
      expect(() => resolveUpgradeJourney(input)).toThrow(/published/);
    },
  );

  it('refuses a deprecated historical stable fixture', () => {
    const input = registry();
    input.versions['2026.7.1-2'].deprecated = 'broken release';
    expect(() => resolveUpgradeJourney(input)).toThrow(/deprecated/);
  });

  it('refuses an unpublished newer tagged beta', () => {
    const input = registry();
    input.distTags.beta = '2026.9.4-beta.1';
    expect(() => resolveUpgradeJourney(input)).toThrow(/published/);
  });
});
