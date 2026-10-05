/**
 * A stored address that is rendered as a link must be an absolute http(s) URL: anything else ("javascript:", "data:",
 * "vbscript:", a relative path) is dropped, so the text shows without being clickable. The server validates the same rule
 * for the website; links that come from external systems are checked here as well (defence in depth, ASVS V1.2).
 */
export function safeHttpUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  // Control characters (tab, CR, LF …) are removed by browsers inside a scheme, which is how "java\tscript:" gets through.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : undefined;
  } catch {
    return undefined;
  }
}
