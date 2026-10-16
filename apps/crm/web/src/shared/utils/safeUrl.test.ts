import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './safeUrl';

describe('safeHttpUrl', () => {
  it('keeps http and https addresses', () => {
    expect(safeHttpUrl('https://havbris.no')).toBe('https://havbris.no');
    expect(safeHttpUrl(' http://havbris.no/a?b=1 ')).toBe('http://havbris.no/a?b=1');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'javascript://x%0Aalert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example',
    '/relative/path',
    'havbris.no',
    'mailto:a@b.no',
    '',
    null,
    undefined,
  ])('drops %s', (value) => {
    expect(safeHttpUrl(value as string | null | undefined)).toBeUndefined();
  });
});
