// Field-level comparison of form values, used to show what changed when a save is refused with 412.

export type Differences = { path: string; mine: unknown; theirs: unknown }[];

/** Keys that would reach the prototype chain when a dot-path is walked or assigned. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Paths whose values differ between two form states (nested objects are compared by leaf). */
export function diffValues(a: unknown, b: unknown, path = ''): { path: string; a: unknown; b: unknown }[] {
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((key) => diffValues(a[key], b[key], path ? `${path}.${key}` : key));
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) ? [] : [{ path, a, b }];
}

/**
 * What the user changed against the version they loaded (`base`), and the fields the server's latest version has changed
 * as well. Fields only the user changed carry over unchanged; the overlapping ones are the ones to look at.
 */
export function compareWithLatest(base: unknown, mine: unknown, latest: unknown) {
  const myChanges = diffValues(base, mine);
  const theirChanges = new Set(diffValues(base, latest).map((d) => d.path));
  const lookup = (source: unknown, path: string) =>
    path.split('.').reduce<unknown>((value, key) => (isObject(value) && !UNSAFE_KEYS.has(key) ? value[key] : undefined), source);
  const overlapping = myChanges.filter((c) => theirChanges.has(c.path));
  const others = [...theirChanges].filter((p) => !myChanges.some((c) => c.path === p));
  return {
    mine: myChanges.map((c) => c.path),
    conflicts: overlapping.map((c) => ({ path: c.path, mine: lookup(mine, c.path), theirs: lookup(latest, c.path) })),
    changedByOthers: others,
  };
}

/** The user's changes laid over the latest server values: only the fields the user touched are taken from `mine`. */
export function rebase<T>(base: T, mine: T, latest: T): T {
  const result = structuredClone(latest) as Record<string, unknown>;
  for (const { path } of diffValues(base, mine)) {
    const keys = path.split('.');
    // A path that names the prototype chain is never copied (prototype pollution, ASVS V1.5): a form field cannot be called that.
    if (keys.some((key) => UNSAFE_KEYS.has(key))) continue;
    let target: Record<string, unknown> = result;
    let source: unknown = mine;
    keys.slice(0, -1).forEach((key) => {
      target[key] = isObject(target[key]) ? target[key] : {};
      target = target[key] as Record<string, unknown>;
      source = isObject(source) ? source[key] : undefined;
    });
    const last = keys.at(-1);
    if (last === undefined) continue;
    target[last] = isObject(source) ? structuredClone(source[last]) : undefined;
  }
  return result as T;
}
