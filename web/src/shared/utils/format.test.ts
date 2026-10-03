import { describe, expect, it } from 'vitest';
import { parseDecimal, todayIso } from './format';

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
