import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import nb from './locales/nb.json';
import ru from './locales/ru.json';

/** Only one language is downloaded at a time, so a missing key shows as a raw key instead of another language. */
function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key));
}

const plural = (key: string) => key.replace(/_(one|few|many|other)$/, '');

describe('locales', () => {
  it('have the same keys in every language', () => {
    const english = new Set(keys(en).map(plural));
    for (const [language, translations] of [['nb', nb], ['ru', ru]] as const) {
      const other = new Set(keys(translations).map(plural));
      expect([...english].filter((k) => !other.has(k)), `missing in ${language}`).toEqual([]);
      expect([...other].filter((k) => !english.has(k)), `extra in ${language}`).toEqual([]);
    }
  });
});
