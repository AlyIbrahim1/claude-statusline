const { normalizeProjectSlug } = require('../scripts/slug-utils');

describe('normalizeProjectSlug()', () => {
  test('normalizes unix separators', () => {
    expect(normalizeProjectSlug('/tmp/myproject')).toBe('-tmp-myproject');
  });

  test('normalizes windows separators', () => {
    expect(normalizeProjectSlug('C:\\work\\repo')).toBe('C:-work-repo');
  });

  test('normalizes mixed separators', () => {
    expect(normalizeProjectSlug('C:/work\\repo')).toBe('C:-work-repo');
  });
});
