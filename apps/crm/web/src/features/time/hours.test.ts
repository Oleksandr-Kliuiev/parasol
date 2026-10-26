import { describe, expect, it } from 'vitest';
import { parseHours, typedAsMinutes } from './hours';

describe('hours as people type them', () => {
  it.each([
    ['1,5', 1.5], ['1.5', 1.5], ['0,75', 0.75], ['2', 2], ['1:30', 1.5], ['0:45', 0.75], ['45 min', 0.75], ['45m', 0.75],
    ['90 minutter', 1.5], ['2 h', 2], ['1,5 t', 1.5], ['3 timer', 3],
  ])('reads %s as %d hours', (text, hours) => expect(parseHours(text)).toBeCloseTo(hours));

  it.each(['abc', '1:75', '¾', '1,5,5', 'h'])('refuses %s instead of guessing', (text) => expect(parseHours(text)).toBeNaN());

  it('treats an empty field as not filled in', () => expect(parseHours('  ')).toBeNull());

  it('knows when the form should echo the hours', () => {
    expect(typedAsMinutes('0:45')).toBe(true); expect(typedAsMinutes('45 min')).toBe(true); expect(typedAsMinutes('1,5')).toBe(false);
  });
});
