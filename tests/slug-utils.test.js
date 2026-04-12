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

  test('returns empty string for empty input', () => {
    expect(normalizeProjectSlug('')).toBe('');
  });

  test('returns empty string for null/undefined', () => {
    expect(normalizeProjectSlug(null)).toBe('');
    expect(normalizeProjectSlug(undefined)).toBe('');
  });

  test('leaves already-normalized paths unchanged', () => {
    expect(normalizeProjectSlug('home-user-project')).toBe('home-user-project');
  });

  test('path with only separators becomes all dashes', () => {
    expect(normalizeProjectSlug('///')).toBe('---');
  });
});
