/**
 * Strict JSON (RFC 8259) for the bounded upstream envelope and the intent content (docs/stage5/ask/remote/03): the same
 * values JSON.parse produces for valid input, but a DUPLICATE object key at ANY depth, nesting deeper than `maxDepth`,
 * trailing content or any syntax error rejects the WHOLE text. There is no repair and no first/last-key selection
 * (JSON.parse alone silently keeps the last duplicate). Keys are defined as own data properties, so "__proto__" is an
 * ordinary key exactly as with JSON.parse. Throws StrictJsonError only; the message never contains input text.
 */
export class StrictJsonError extends Error { constructor() { super('STRICT_JSON_INVALID'); this.name = 'StrictJsonError'; } }
const fail = (): never => { throw new StrictJsonError(); };

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

export function parseStrictJson(text: string, maxDepth = 32): unknown {
  let i = 0;
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i += 1; };
  const string = (): string => {
    if (text[i] !== '"') fail();
    i += 1;
    let out = '';
    for (;;) {
      if (i >= text.length) fail();
      const c = text.charCodeAt(i);
      if (c === 0x22) { i += 1; return out; }
      if (c < 0x20) fail();
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          if (e === undefined || !Object.hasOwn(ESCAPES, e)) fail();
          out += ESCAPES[e!]!;
          i += 2;
        }
        continue;
      }
      out += text[i];
      i += 1;
    }
  };
  const value = (depth: number): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      if (depth >= maxDepth) fail();
      i += 1;
      const object: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') { i += 1; return object; }
      for (;;) {
        ws();
        const key = string();
        if (seen.has(key)) fail();
        seen.add(key);
        ws();
        if (text[i] !== ':') fail();
        i += 1;
        Object.defineProperty(object, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return object; }
        return fail();
      }
    }
    if (c === '[') {
      if (depth >= maxDepth) fail();
      i += 1;
      const array: unknown[] = [];
      ws();
      if (text[i] === ']') { i += 1; return array; }
      for (;;) {
        array.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return array; }
        return fail();
      }
    }
    if (c === '"') return string();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    NUMBER.lastIndex = i;
    const match = NUMBER.exec(text);
    if (!match || match[0].length === 0) return fail();
    i += match[0].length;
    return Number(match[0]);
  };
  const result = value(0);
  ws();
  if (i !== text.length) fail();
  return result;
}
