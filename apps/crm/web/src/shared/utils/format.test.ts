import { afterEach, describe, expect, it } from 'vitest';
import i18n, { changeLanguage } from '../../i18n';
import { formatReadAt, formatRelative, parseDecimal, todayIso } from './format';

describe('parseDecimal', () => {
  it('accepts decimal comma, point and spaces', () => {
    expect(parseDecimal('16,5')).toBe(16.5);
    expect(parseDecimal('1 250.75')).toBe(1250.75);
    expect(parseDecimal('-2')).toBe(-2);
  });

  it('returns null for empty input and NaN for text', () => {
    expect(parseDecimal('  ')).toBeNull();
    expect(parseDecimal('abc')).toBeNaN();
  });
});

describe('todayIso', () => {
  it('uses the DateOnly format of the API', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  afterEach(async () => { await changeLanguage('en'); });

  it('names the age in whole units, and a moment ahead of our clock as just now', () => {
    expect(formatRelative(ago(20), now)).toBe('just now');
    expect(formatRelative(ago(-300), now)).toBe('just now');
    expect(formatRelative(ago(60), now)).toBe('1 minute ago');
    expect(formatRelative(ago(3 * 3600 + 59), now)).toBe('3 hours ago');
    expect(formatRelative(ago(19 * 86400), now)).toBe('19 days ago');
    expect(formatRelative(ago(400 * 86400), now)).toBe('1 year ago');
    expect(formatRelative(null, now)).toBe('');
  });

  it('speaks Nynorsk from our own strings, whatever Intl data the browser has', async () => {
    await changeLanguage('nn');
    expect(i18n.language).toBe('nn');
    expect(formatRelative(ago(19 * 86400), now)).toBe('for 19 dagar sidan');
    expect(formatRelative(ago(2 * 3600), now)).toBe('for 2 timar sidan');
  });
});

describe('formatReadAt', () => {
  it('shows only the clock for a reading made today in Oslo, the date as well for an older one', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    expect(formatReadAt('2026-10-20T08:30:00Z', now)).toBe('10:30');
    expect(formatReadAt('2026-10-19T08:30:00Z', now)).toMatch(/19\/10\/2026/);
  });
});
