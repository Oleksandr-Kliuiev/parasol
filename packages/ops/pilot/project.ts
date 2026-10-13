import { AtlasError } from '../../core/contracts.ts';
import { M365_CONFIG_VERSION } from '../../../connectors/microsoft365/contract.ts';
import { CORRELATION_CONTRACT_VERSION, CORRELATION_RULE_VERSION, CORRELATION_SOURCE_SCOPE } from '../../correlation/contracts.ts';
import { millisecondInstant } from '../../correlation/parameters.ts';
import { DIRECTORY_LIST_CONTRACT_VERSION } from '../../m365/read-contracts.ts';
import type { Flags } from '../commands.ts';
import type { PilotCommand } from './config.ts';

/**
 * Public projection of one accepted command result (operational brief RC5): an explicit allowlist built in memory from the
 * service output — safe statuses/codes, counts, time bounds, booleans, relation/proof labels and run-local opaque aliases
 * (`connection-1`, `request-1`, …) for local Atlas IDs. Never DTOs, names/UPNs, vendor/source/tenant IDs, local IDs, cursor
 * values, URLs, configuration or free text; no hash of any value. Every field passes a typed check; anything unexpected
 * refuses the whole projection (PILOT_PROJECTION_REFUSED) instead of being passed through. A final walk asserts that each
 * string is a code, a timestamp, an alias, digits or a known literal. Item/page counts come from the service output only.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, unknown>;
export const projectionRefused = () => new AtlasError('PILOT_PROJECTION_REFUSED', 'PERMANENT');

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ALIAS = /^(connection|request|window|generation|observation|link)-[1-9]\d{0,5}$/;
const DIGITS = /^\d{1,10}$/;
const RESOURCE_TYPES = ['customer', 'organization', 'agent', 'contact', 'alert', 'ticket', 'incident', 'm365_user', 'm365_device', 'm365_signin'];
const LITERALS = new Set<string>([...RESOURCE_TYPES, 'atera', 'huntress', 'microsoft365', 'directory', 'create', 'resume', 'userId', 'deviceDetail.deviceId',
  CORRELATION_CONTRACT_VERSION, CORRELATION_RULE_VERSION, CORRELATION_SOURCE_SCOPE, DIRECTORY_LIST_CONTRACT_VERSION, M365_CONFIG_VERSION]);

const obj = (v: unknown): Obj => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw projectionRefused(); return v as Obj; };
const arr = (v: unknown, max = 10_000): unknown[] => { if (!Array.isArray(v) || v.length > max) throw projectionRefused(); return v; };
const nullable = <T>(check: (v: unknown) => T) => (v: unknown): T | null => (v === null || v === undefined ? null : check(v));
const code = (v: unknown): string => { if (typeof v !== 'string' || !CODE.test(v)) throw projectionRefused(); return v; };
const iso = (v: unknown): string => { if (typeof v !== 'string' || !ISO.test(v)) throw projectionRefused(); return v; };
const int = (v: unknown): number => { if (!Number.isSafeInteger(v) || (v as number) < 0) throw projectionRefused(); return v as number; };
const bool = (v: unknown): boolean => { if (typeof v !== 'boolean') throw projectionRefused(); return v; };
const digits = (v: unknown): string => { if (typeof v !== 'string' || !DIGITS.test(v)) throw projectionRefused(); return v; };
const oneOf = (values: readonly string[]) => (v: unknown): string => { if (typeof v !== 'string' || !values.includes(v)) throw projectionRefused(); return v; };
const codes = (v: unknown): string[] => arr(v, 64).map(code);
const resourceType = oneOf(RESOURCE_TYPES);

/** Run-local opaque aliases: the first local ID of a kind becomes `<kind>-1`, and so on. The mapping stays private. */
export class Aliases {
  readonly #ids = new Map<string, string>(); readonly #counts = new Map<string, number>(); readonly #private: [string, string][] = [];
  of(kind: 'connection' | 'request' | 'window' | 'generation' | 'observation' | 'link', id: unknown): string | null {
    if (id === null || id === undefined) return null;
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) throw projectionRefused();
    const key = `${kind}\u0000${id}`;
    let alias = this.#ids.get(key);
    if (!alias) {
      const n = (this.#counts.get(kind) ?? 0) + 1; this.#counts.set(kind, n);
      alias = `${kind}-${n}`; this.#ids.set(key, alias); this.#private.push([alias, id]);
    }
    return alias;
  }
  /** For the optional PRIVATE operator file only (resume IDs); never public output. */
  privateEntries(): [string, string][] { return this.#private.map(([a, id]) => [a, id]); }
}

function correlationResource(v: unknown, a: Aliases): Json {
  const r = obj(v);
  return { resourceType: resourceType(r.resourceType), status: code(r.status), coverage: code(r.coverage), lastSuccessAt: nullable(iso)(r.lastSuccessAt),
    asOf: nullable(iso)(r.asOf), safeErrorCode: nullable(code)(r.safeErrorCode), generation: a.of('generation', r.generationId) };
}
const window = (v: unknown): Json => { const w = obj(v); return { fromInclusive: iso(w.fromInclusive), toExclusive: iso(w.toExclusive) }; };
const listPresence = (r: Obj): Obj => ({ itemsPresent: r.items !== null, itemCount: r.items === null ? null : arr(r.items).length, total: int(r.total),
  truncated: bool(r.truncated), nextCursorPresent: r.nextCursor !== null && r.nextCursor !== undefined });

const PROJECTIONS: Readonly<Record<PilotCommand, (output: Obj, a: Aliases, flags: Flags) => Json>> = {
  'm365-probe': (o, a) => ({ status: oneOf(['ACTIVE', 'DISABLED'])(o.status), connection: a.of('connection', o.connectionId),
    lifecycleVersion: nullable(int)(o.lifecycleVersion), signIns: nullable(oneOf(['AVAILABLE', 'UNAVAILABLE']))(o.signIns), safeErrorCode: nullable(code)(o.safeErrorCode) }),
  'm365-sync': (o, a, f): Json => {
    if (o.mode === undefined) {
      return { mode: 'directory', resourceType: oneOf(['m365_user', 'm365_device'])(o.resourceType), status: oneOf(['PUBLISHED', 'FAILED'])(o.status),
        attemptSeq: int(o.attemptSeq), generation: a.of('generation', o.generationId), rowCount: nullable(int)(o.rowCount), recorded: bool(o.recorded),
        safeErrorCode: nullable(code)(o.safeErrorCode), errorKind: nullable(code)(o.errorKind), retryAfterSeconds: nullable(digits)(o.retryAfterSeconds),
        retryAt: nullable(iso)(o.retryAt), attemptsUsed: int(o.attemptsUsed), maxAttempts: int(o.maxAttempts) };
    }
    const mode = oneOf(['create', 'resume'])(o.mode);
    return { mode, request: a.of('request', o.requestId),
      ...(mode === 'create' ? { requestedFrom: millisecondInstant(f.from, 'from').toISOString(), requestedTo: millisecondInstant(f.to, 'to').toISOString(), retrievalFrom: nullable(iso)(o.retrievalFrom), retrievalTo: nullable(iso)(o.retrievalTo) } : {}),
      roots: arr(o.roots, 64).map(x => { const r = obj(x); return { window: a.of('window', r.windowId), rootFrom: iso(r.rootFrom), outcome: code(r.outcome),
        attemptSeq: nullable(int)(r.attemptSeq), safeErrorCode: nullable(code)(r.safeErrorCode), retryAt: nullable(iso)(r.retryAt),
        evidenceCount: nullable(int)(r.evidenceCount), attemptsUsed: nullable(int)(r.attemptsUsed), maxAttempts: nullable(int)(r.maxAttempts) }; }) };
  },
  'm365-status': (o, a) => {
    const s = obj(o.signIns); const w = obj(s.windows);
    const request = o.request === null ? null : (() => { const r = obj(o.request); return { request: a.of('request', r.requestId), outcome: code(r.outcome),
      rootCount: int(r.rootCount), createdAt: iso(r.createdAt), requestedFrom: iso(r.requestedFrom), requestedTo: iso(r.requestedTo),
      retrievalFrom: nullable(iso)(r.retrievalFrom), retrievalTo: nullable(iso)(r.retrievalTo), configVersion: oneOf([M365_CONFIG_VERSION])(r.configVersion),
      totalLeaves: int(r.totalLeaves), totalStagedRows: int(r.totalStagedRows),
      roots: arr(r.roots, 64).map(x => { const j = obj(x); return { window: a.of('window', j.windowId), rootFrom: iso(j.rootFrom), state: code(j.state),
        attemptsUsed: int(j.attemptsUsed), maxAttempts: int(j.maxAttempts), retryAt: nullable(iso)(j.retryAt), safeErrorCode: nullable(code)(j.safeErrorCode) }; }) }; })();
    return { connection: a.of('connection', o.connectionId), connectionStatus: code(o.connectionStatus), lifecycleVersion: int(o.lifecycleVersion), assessedAt: iso(o.assessedAt),
      directory: arr(o.directory, 4).map(x => { const d = obj(x); return { resourceType: oneOf(['m365_user', 'm365_device'])(d.resourceType), status: code(d.status),
        reasonCodes: codes(d.reasonCodes), attemptsUsed: nullable(int)(d.attemptsUsed), maxAttempts: nullable(int)(d.maxAttempts), retryAt: nullable(iso)(d.retryAt),
        lastAttemptAt: nullable(iso)(d.lastAttemptAt), lastSuccessAt: nullable(iso)(d.lastSuccessAt), generation: a.of('generation', d.activeGenerationId),
        rowCount: nullable(int)(d.rowCount) }; }),
      signIns: { capability: nullable(code)(s.capability), safeErrorCode: nullable(code)(s.safeErrorCode),
        windows: { total: int(w.total), ok: int(w.ok), error: int(w.error), pending: int(w.pending), missing: int(w.missing) } }, request };
  },
  'm365-directory': (o, a) => ({ contractVersion: oneOf([DIRECTORY_LIST_CONTRACT_VERSION])(o.contractVersion), connection: a.of('connection', o.m365ConnectionId),
    resourceType: oneOf(['m365_user', 'm365_device'])(o.resourceType), resource: correlationResource(o.resource, a), ...listPresence(o) } as Json),
  correlation: (o, a) => {
    const res = obj(o.resolution); const cov = obj(o.coverage); const src = obj(o.source);
    return { contractVersion: oneOf([CORRELATION_CONTRACT_VERSION])(o.contractVersion), ruleVersion: oneOf([CORRELATION_RULE_VERSION])(o.ruleVersion),
      observation: a.of('observation', o.observationId), connection: a.of('connection', o.m365ConnectionId),
      source: { severity: code(src.severity), priority: code(src.priority), route: code(src.route) }, window: window(o.window),
      resources: arr(o.resources, 8).map(r => correlationResource(r, a)),
      resolution: { device: code(res.device), person: code(res.person), reasonCodes: codes(res.reasonCodes) },
      coverage: { status: code(cov.status), traversalComplete: bool(cov.traversalComplete), freshness: code(cov.freshness),
        sourceScope: oneOf([CORRELATION_SOURCE_SCOPE])(cov.sourceScope), assessedAt: iso(cov.assessedAt), completedWindows: arr(cov.completedWindows).length,
        gaps: arr(cov.gaps, 1000).map(g => { const x = obj(g); return { fromInclusive: iso(x.fromInclusive), toExclusive: iso(x.toExclusive), reasonCode: code(x.reasonCode) }; }) },
      relations: o.items === null ? null : arr(o.items).map(x => { const i = obj(x); return { relationCodes: codes(i.relationCodes), evidenceState: code(i.evidenceState),
        canonicalPersonPresent: i.canonicalPersonId !== undefined && i.canonicalPersonId !== null,
        proof: arr(i.proof, 8).map(p => { const q = obj(p); return { relation: code(q.relation), vendorField: oneOf(['userId', 'deviceDetail.deviceId'])(q.vendorField),
          linkStatuses: codes(q.linkStatuses), linkCount: arr(q.linkIds, 16).length, directoryGenerationCount: arr(q.directoryGenerationIds, 16).length }; }) }; }),
      ...listPresence(o) } as Json;
  },
  'live-read': (o, a) => {
    const act = obj(o.activation); const h = o.health === null ? null : obj(o.health); const id = o.identities === null ? null : obj(o.identities);
    return { connection: a.of('connection', o.connectionId), system: nullable(oneOf(['atera', 'huntress']))(o.system),
      activation: { status: code(act.status), safeErrorCode: nullable(code)(act.safeErrorCode) },
      health: h && { status: code(h.status), safeErrorCode: nullable(code)(h.safeErrorCode) },
      identities: id && { status: code(id.status), registered: int(id.registered), candidates: int(id.candidates), ambiguous: int(id.ambiguous),
        safeErrorCode: nullable(code)(id.safeErrorCode) },
      resources: arr(o.resources, 16).map(x => { const r = obj(x); return { resourceType: resourceType(r.resourceType), status: code(r.status),
        itemCount: nullable(int)(r.itemCount), eventsStored: int(r.eventsStored), safeErrorCode: nullable(code)(r.safeErrorCode),
        retryAfterSeconds: nullable(digits)(r.retryAfterSeconds) }; }) };
  },
  mapping: (o, a) => {
    const items = arr(o.items, 1000).map(x => { const i = obj(x); return { link: a.of('link', i.linkId), status: code(i.status), resourceType: resourceType(i.resourceType),
      entityKind: code(i.entityKind), system: oneOf(['atera', 'huntress', 'microsoft365'])(i.system), method: code(i.method), reasonCode: nullable(code)(i.reasonCode),
      conflictsWith: a.of('link', i.conflictsWithLinkId) }; });
    return { itemCount: items.length, items };
  },
  'confirm-link': (o, a) => ({ link: a.of('link', o.linkId), status: code(o.status), conflictsWith: a.of('link', o.conflictsWithLinkId) }),
};

/** Every string of a projected value is a code, a timestamp, an alias, digits or a known literal; keys are identifiers. */
export function assertSafeTree(value: unknown, depth = 0): void {
  if (depth > 12) throw projectionRefused();
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value === 'string') {
    if (!(CODE.test(value) || ISO.test(value) || ALIAS.test(value) || DIGITS.test(value) || LITERALS.has(value))) throw projectionRefused();
    return;
  }
  if (Array.isArray(value)) { value.forEach(v => assertSafeTree(v, depth + 1)); return; }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) { if (!/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(k)) throw projectionRefused(); assertSafeTree(v, depth + 1); }
    return;
  }
  throw projectionRefused();
}

/** The allowlisted projection of one command output; the configured connection (if any) is always `connection-1`. */
export function projectResult(command: PilotCommand, output: unknown, aliases: Aliases, flags: Flags): Json {
  aliases.of('connection', flags.connection);
  if (command === 'confirm-link') aliases.of('link', flags.link);
  if (command === 'correlation') aliases.of('observation', flags.observation);
  const projected = PROJECTIONS[command](obj(output), aliases, flags);
  assertSafeTree(projected);
  return projected;
}
