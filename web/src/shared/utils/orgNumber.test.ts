import { describe, expect, it } from 'vitest';
import { formatOrgNumber, isValidOrgNumber, looksLikeOrgNumber } from './orgNumber';

describe('orgNumber', () => {
  it.each(['923609016', '974760673', '923 609 016'])('accepts valid number %s', (value) => {
    expect(isValidOrgNumber(value)).toBe(true);
  });

  it.each(['923609017', '12345678', '1234567890', '92360901A', '', null])('rejects %s', (value) => {
    expect(isValidOrgNumber(value)).toBe(false);
  });

  it('formats in groups of three', () => {
    expect(formatOrgNumber('923609016')).toBe('923 609 016');
    expect(formatOrgNumber('abc')).toBe('abc');
  });

  it('recognizes org numbers typed with spaces', () => {
    expect(looksLikeOrgNumber('923 609 016')).toBe(true);
    expect(looksLikeOrgNumber('Equinor')).toBe(false);
  });
});
