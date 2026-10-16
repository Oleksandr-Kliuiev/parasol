import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { powerOfficeError } from './contracts.ts';
import { withPowerOfficeAuthority } from './authority.ts';
import type { PowerOfficeCredential } from './authority.ts';
import { checkBinding } from './binding.ts';
import { lockState } from './locks.ts';
import type { PowerOfficeKey, StateRow } from './locks.ts';
import { compositionPort } from './composition.ts';
import { insertAudit } from './rows.ts';
import { decideRead, statusDto, summaryDto } from './read-contracts.ts';
import type { PowerOfficeStatusDto, PowerOfficeSummaryDto, ReadFacts, ReadView } from './read-contracts.ts';

/**
 * Dedicated PowerOffice status/summary reads (docs/stage4/04_PORT_AND_SYNC.md "Read view", 03 "Protected reads and lock
 * order", 02 "Public interface"). The public service takes only the trusted composition (mode first: DISABLED/
 * MODE_UNSUPPORTED before any database work), the private bearer credential and the explicit client/connection; no
 * Actor, permission, clock or source. ONE authority transaction (authority.ts, operation read): bearer → workspace fence
 * FOR SHARE → readiness → current all-of context:read + poweroffice:read on ONE membership (otherwise exactly one
 * workspace denial, nothing else) → client scope + plain scoped Connection read → State FOR SHARE when present (never
 * initialized) → token/expiry/ACTIVE actor/rights again after ALL locks. Then, in this order:
 *   - unknown, invisible or non-PowerOffice connection: POWEROFFICE_NOT_FOUND (no audit, no data);
 *   - binding invalid/unavailable or the current snapshot of another lifecycle: UNAVAILABLE — decided from the Connection
 *     and the State pointer alone, BEFORE any Snapshot read (no financial read without a valid binding);
 *   - otherwise plain protected reads of the pointer's Snapshot (expiry and age computed in SQL against ONE DB clock read
 *     after the locks; an expired payload is not even selected) and of the last Attempt (local ID/sequence, status only).
 * The read client-audit row (six-key metadata: connectionId, outcome READ, snapshotId when shown, safeErrorCode) is
 * inserted in the same transaction and must commit before any DTO leaves: an audit failure is POWEROFFICE_AUDIT_FAILED
 * (or DB_CONFLICT) with no payload. Nothing else is written; no State/domain row changes; no port or source call. Fence
 * SHARE + State SHARE exclude a concurrent publication/cleanup, so a read sees the coherent old or new snapshot.
 */
type Kind = 'status' | 'summary';
const ISO = (column: string) => `to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

interface SnapshotRow { expired: boolean; stale: boolean; lifecycleVersion: number; asOf: string; expiresAt: string; businessDate: string; summary: unknown }
/** The pointer's snapshot (plain read) with expiry/staleness against one DB clock read; the payload only while unexpired. */
async function readSnapshot(tx: Prisma.TransactionClient, key: PowerOfficeKey, snapshotId: string, kind: Kind): Promise<SnapshotRow | null> {
  const payload = kind === 'summary' ? `CASE WHEN n.c < s."expiresAt" THEN s.summary END` : 'NULL::jsonb';
  const rows = await tx.$queryRawUnsafe<SnapshotRow[]>(`SELECT n.c >= s."expiresAt" AS expired, n.c - s."asOf" > interval '15 minutes' AS stale,
      s."lifecycleVersion", ${ISO('s."asOf"')} AS "asOf", ${ISO('s."expiresAt"')} AS "expiresAt", to_char(s."businessDate", 'YYYY-MM-DD') AS "businessDate",
      ${payload} AS summary
    FROM public."PowerOfficeSnapshot" s, (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS c) n
    WHERE s."workspaceId" = $1 AND s."clientId" = $2 AND s."connectionId" = $3 AND s.id = $4::uuid`,
  key.workspaceId, key.clientId, key.connectionId, snapshotId);
  return rows[0] ?? null;
}
async function lastAttemptSequence(tx: Prisma.TransactionClient, key: PowerOfficeKey, attemptId: string): Promise<number | null> {
  const rows = await tx.$queryRawUnsafe<{ sequence: number }[]>(`SELECT sequence FROM public."PowerOfficeAttempt"
    WHERE "workspaceId" = $1 AND "clientId" = $2 AND "connectionId" = $3 AND id = $4::uuid`, key.workspaceId, key.clientId, key.connectionId, attemptId);
  return rows[0] === undefined ? null : Number(rows[0].sequence);
}
async function instant(tx: Prisma.TransactionClient, key: PowerOfficeKey): Promise<string | null> {
  const rows = await tx.$queryRawUnsafe<{ at: string | null }[]>(`SELECT ${ISO('"lastSuccessAt"')} AS at FROM public."PowerOfficeState"
    WHERE "workspaceId" = $1 AND "clientId" = $2 AND "connectionId" = $3`, key.workspaceId, key.clientId, key.connectionId);
  return rows[0]?.at ?? null;
}

async function readPowerOffice<T>(db: PrismaClient, composition: unknown, credential: PowerOfficeCredential, clientId: string, connectionId: string,
  kind: Kind, build: (view: ReadView) => T): Promise<T> {
  compositionPort(composition); // mode first; reads never call the port
  if (typeof clientId !== 'string' || typeof connectionId !== 'string') throw powerOfficeError('INVALID_ARGUMENTS');
  return withPowerOfficeAuthority<StateRow | null, T>(db, credential, { clientId, connectionId, operation: 'read' }, {
    async lock(tx, scope) {
      if (!SCOPE_ID_PATTERN.test(scope.connectionId)) return null;
      return lockState(tx, { workspaceId: scope.workspaceId, clientId: scope.clientId, connectionId: scope.connectionId }, 'SHARE');
    },
    async run(tx, authority, state) {
      const binding = checkBinding(authority.connection, 'read');
      if ('refused' in binding && binding.refused === 'POWEROFFICE_NOT_FOUND') return { refused: 'POWEROFFICE_NOT_FOUND' };
      const key: PowerOfficeKey = { workspaceId: authority.workspaceId, clientId: authority.clientId, connectionId: authority.connectionId };
      let bindingFact: ReadFacts['binding'] = 'VALID';
      if ('refused' in binding) bindingFact = 'POWEROFFICE_CONNECTION_UNAVAILABLE';
      else if (state?.snapshotId != null && state.snapshotVersion !== binding.binding.lifecycleVersion) bindingFact = 'POWEROFFICE_BINDING_CHANGED';
      const snapshot = bindingFact === 'VALID' && state?.snapshotId ? await readSnapshot(tx, key, state.snapshotId, kind) : null;
      if (snapshot !== null && 'binding' in binding && Number(snapshot.lifecycleVersion) !== binding.binding.lifecycleVersion) throw powerOfficeError('UNEXPECTED_ERROR');
      const decision = decideRead({ binding: bindingFact, priorSuccess: state?.lastSuccessAt != null, lastCompletedState: state?.lastCompletedState ?? null,
        lastCompletedErrorCode: state?.lastCompletedErrorCode ?? null, snapshot: snapshot === null ? null : { expired: snapshot.expired, stale: snapshot.stale } });
      const view: ReadView = {
        connectionId: key.connectionId, decision,
        snapshot: snapshot === null || !decision.visible ? null
          : { asOf: snapshot.asOf, expiresAt: snapshot.expiresAt, businessDate: snapshot.businessDate, summary: snapshot.summary },
        lastAttemptState: state?.lastAttemptState ?? null, lastAttemptId: kind === 'status' ? state?.lastAttemptId ?? null : null,
        lastAttemptSequence: kind === 'status' && state?.lastAttemptId ? await lastAttemptSequence(tx, key, state.lastAttemptId) : null,
        lastCompletedState: state?.lastCompletedState ?? null, lastCompletedErrorCode: state?.lastCompletedErrorCode ?? null,
        lastSuccessAt: kind === 'status' && state?.lastSuccessAt != null ? await instant(tx, key) : null,
      };
      const dto = build(view); // exact whitelist + output validation BEFORE the audit commits
      await insertAudit(tx, key, { id: randomUUID(), actorId: authority.actorId, correlationId: authority.correlationId, eventType: `poweroffice.${kind}.read` },
        { connectionId: key.connectionId, outcome: 'READ', ...(decision.visible && state?.snapshotId ? { snapshotId: state.snapshotId } : {}),
          ...(decision.safeErrorCode === null ? {} : { safeErrorCode: decision.safeErrorCode }) });
      return { ok: dto };
    },
  });
}

/** Status: integration state, freshness and local attempt metadata; never a summary, amount or count. */
export function readPowerOfficeStatus(db: PrismaClient, composition: unknown, credential: PowerOfficeCredential, clientId: string,
  connectionId: string): Promise<PowerOfficeStatusDto> {
  return readPowerOffice(db, composition, credential, clientId, connectionId, 'status', statusDto);
}
/** Summary: 02's exact eleven-field DTO; the bounded aggregate only for FRESH/STALE, a known empty export stays {0, []}. */
export function readPowerOfficeSummary(db: PrismaClient, composition: unknown, credential: PowerOfficeCredential, clientId: string,
  connectionId: string): Promise<PowerOfficeSummaryDto> {
  return readPowerOffice(db, composition, credential, clientId, connectionId, 'summary', summaryDto);
}
