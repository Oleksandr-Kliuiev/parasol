import type { PrismaClient } from '@prisma/client';
import { setLocal } from '../../auth/transaction-token.ts';
import { clientAuditData } from '../../audit/prisma.ts';
import { sqlState } from '../../graph/fence-errors.ts';
import { ASK_LIMITS, AskFailure, askFailure, isAskFailure } from '../contracts.ts';
import type { AskErrorCode } from '../contracts.ts';
import { dbAskPort } from '../authority.ts';
import type { AskCredential } from '../credential.ts';
import { clearSettings, digestOf, fencedAuthority, phaseFailure, phaseTx, stillCurrent } from '../db-phase.ts';
import type { Phase } from '../db-phase.ts';
import type { PhaseRun, PhaseSql } from '../phase.ts';
import { readDbSource } from '../read.ts';
import { AskStopped } from '../service.ts';
import type { AskIdentity, AskRun } from '../service.ts';
import type { AskSourceRead, Scope } from '../source.ts';
import type { PauseReason } from './budget.ts';
import { ASK_REMOTE_PERMISSIONS, AskRemoteFailure, EGRESS_FLOOR_MS, PAUSE_PHASE_MS, SETTLEMENT_PHASE_MS, decidedCode, remoteAuditRecord } from './contracts.ts';
import type { AskRemoteAcknowledgement, RemoteAuditOutcome, RemoteReplyCode } from './contracts.ts';
import { admitEgress, takeSettlement } from './dispatch.ts';
import type { AttemptRef, DispatchCapability } from './dispatch.ts';
import { ASK_REMOTE_SQLSTATES, FLOOR_SQLSTATE, PAUSE_SQL, RESERVE_FLOOR_SQL, SETTLE_SQL, pauseParams, reserveFloorParams, settleParams } from './ledger-sql.ts';
import type { AskRemoteLedgerCode } from './ledger-sql.ts';
import type { PreparedPayload } from './payload.ts';
import type { EvaluationPhases } from './evaluation.ts';
import { DESIGN_PACKAGE_SHA256, PROMPT_SHA256, SCHEMA_SHA256 } from './profile.ts';

/**
 * ASK-REMOTE DB port (docs/stage5/ask/remote/04), confined runtime role, the SAME bounded phases and fenced authority as the
 * accepted Ask port (db-phase.ts). Every request phase takes min(2 s, remaining original budget), held by the request owner.
 *   capability: current token → workspace policy read only (no client source, charge, provider or completion audit).
 *   phase1:     fence FIRST FOR SHARE → current bearer/ACTIVE actor/ONE membership with context:read AND ask:remote →
 *               policy: consent tuple FIRST (409), then active/unexpired (DB clock)/exact profile/region/data class/prompt/
 *               schema/package/reserve and the exact client admission (503) → local circuit → rolling charge → source read.
 *   egress:     the same fenced authority + captured workspace/actor/epoch equality + the captured policy tuple/price/secret
 *               → DB-clock sample → original remaining ≥4500 ms → reserve_floor (MONTH → DAY → attempt, floor re-checked by the
 *               routine after every lock wait and before RETURN) → post-INSERT current token and policy → floor again →
 *               COMMIT. Only a fulfilled transaction mints the dispatch capability (dispatch.ts); unknown commit mints nothing.
 *   settle:     separate financial-only transaction with its OWN 2 s clock, independent of the request's terminal state:
 *               scoped settings → atlas_ask_remote_settle (MONTH → DAY → attempt; never the fence or the policy).
 *   pause:      separate own-clock transaction: workspace setting → atlas_ask_remote_pause (fence FIRST FOR UPDATE → policy).
 *   phase2:     fenced authority again, epoch equality, the captured policy tuple still current and active, final audit
 *               INSERT, then DB-clock token and policy again immediately before the transaction returns.
 */
export interface RemotePolicyView { readonly admissionId: string; readonly policyVersion: string; readonly priceRevision: string; readonly secretRef: string }
/** `consent` is the operator's acknowledged tuple as submitted; the reservation routine compares IT (not the phase1 capture). */
export interface RemoteAdmission {
  readonly scope: Scope; readonly epoch: string; readonly source: AskSourceRead; readonly policy: RemotePolicyView; readonly consent: AskRemoteAcknowledgement;
}
export interface RemoteAskPort {
  readonly sourceMode: 'db';
  credential(authorization: unknown): AskCredential | null;
  authenticate(run: AskRun, credential: AskCredential): Promise<AskIdentity | null>;
  capability(run: AskRun, identity: AskIdentity, credential: AskCredential): Promise<AskRemoteAcknowledgement>;
  admit(run: AskRun, identity: AskIdentity, credential: AskCredential, clientId: string, focusId: string | null, consent: AskRemoteAcknowledgement,
    allows: (workspaceId: string, policyVersion: bigint) => boolean, evaluation?: EvaluationPhases): Promise<RemoteAdmission>;
  egress(run: AskRun, identity: AskIdentity, credential: AskCredential, admission: RemoteAdmission, prepared: PreparedPayload,
    evaluation?: EvaluationPhases): Promise<DispatchCapability>;
  settle(hold: (work: Promise<unknown>) => void, capability: DispatchCapability): Promise<void>;
  pause(hold: (work: Promise<unknown>) => void, attempt: AttemptRef, reason: PauseReason): Promise<bigint>;
  publish(run: AskRun, identity: AskIdentity, credential: AskCredential, admission: RemoteAdmission, outcome: RemoteAuditOutcome,
    evaluation?: EvaluationPhases): Promise<void>;
}
/** The egress COMMIT outcome is unknown (the body returned; COMMIT failed, timed out or was not confirmed): nothing minted. */
export class EgressUnknown extends Error { constructor() { super('ASK_REMOTE_EGRESS_UNKNOWN'); this.name = 'EgressUnknown'; } }
/** R-EVAL RS-C-A observation only: the settlement COMMIT outcome is unknown (vs a known failure before COMMIT). */
export class SettlementUnknown extends Error { constructor() { super('ASK_REMOTE_SETTLEMENT_UNKNOWN'); this.name = 'SettlementUnknown'; } }

const fail = (code: RemoteReplyCode): never => {
  if ((code as string).startsWith('ASK_REMOTE_')) throw new AskRemoteFailure(code as AskRemoteFailure['code']);
  throw new AskFailure(code as AskErrorCode);
};
const LEDGER_REPLY: Readonly<Partial<Record<AskRemoteLedgerCode, RemoteReplyCode>>> = Object.freeze({
  ASK_REMOTE_NOT_ADMITTED: 'ASK_REMOTE_NOT_ADMITTED', ASK_REMOTE_POLICY_CHANGED: 'ASK_REMOTE_POLICY_CHANGED', ASK_REMOTE_BUDGET: 'ASK_REMOTE_BUDGET',
  ASK_REMOTE_AUTHORITY_CHANGED: 'ASK_SCOPE_CHANGED'
});
/** Decided codes pass; remote SQLSTATEs map to their fixed reply (other AR codes → not ready); else the accepted phase mapping. */
const failureOf = (phase: Phase) => (error: unknown, committed: boolean): Error => {
  if (error instanceof AskRemoteFailure || isAskFailure(error)) return error;
  const state = sqlState(error);
  if (state === FLOOR_SQLSTATE) return new AskFailure('ASK_DEADLINE');
  const ledger = state !== undefined && Object.hasOwn(ASK_REMOTE_SQLSTATES, state) ? ASK_REMOTE_SQLSTATES[state]! : null;
  if (ledger !== null) {
    try { fail(LEDGER_REPLY[ledger] ?? 'ASK_RUNTIME_NOT_READY'); } catch (mapped) { return mapped as Error; }
  }
  return new AskFailure(phaseFailure(phase, error, committed));
};
async function remoteTx<T>(db: PrismaClient, run: AskRun, phase: Phase, fn: (sql: PhaseSql) => Promise<T>): Promise<T> {
  run.check();
  const ms = run.deadline.phase(ASK_LIMITS.phaseMs);
  if (ms < 1) askFailure('ASK_DEADLINE');
  return phaseTx(db, run, ms, work => run.owner.hold(work), fn, failureOf(phase));
}
/** Financial drain clock: never stopped by the request's terminal state; only its own absolute end bounds it. */
const DRAIN: PhaseRun = Object.freeze({ check() { /* independent of AskRun.terminal (04 settlement/pause) */ } });

const POLICY_SQL = `SELECT "admissionId"::text AS "admissionId", "policyVersion"::text AS "policyVersion", state, profile, "endpointRegion" AS region,
  "dataClass", "promptSha256", "schemaSha256", "packageSha256", "secretRef", "priceRevision", "reserveMicroUsd"::text AS "reserveMicroUsd",
  ("expiresAt" > clock_timestamp()) AS unexpired FROM public."RemoteAskPolicy" WHERE "workspaceId" = $1`;
const CLIENT_SQL = `SELECT state FROM public."RemoteAskClientAdmission" WHERE "workspaceId" = $1 AND "admissionId" = $2::uuid AND "clientId" = $3`;
const CLOCK_SQL = `SELECT clock_timestamp()::text AS now`;
interface PolicyRow {
  admissionId: string; policyVersion: string; state: string; profile: string; region: string; dataClass: string; promptSha256: string;
  schemaSha256: string; packageSha256: string; secretRef: string; priceRevision: string; reserveMicroUsd: string; unexpired: boolean;
}
const readPolicy = async (sql: PhaseSql, workspaceId: string): Promise<PolicyRow | null> =>
  (await sql(tx => tx.$queryRawUnsafe<PolicyRow[]>(POLICY_SQL, workspaceId)))[0] ?? null;
/** Active, unexpired on the DB clock and exactly this compiled profile (prompt/schema/package identities, EU, SYNTHETIC, reserve). */
const active = (p: PolicyRow): boolean => p.state === 'ACTIVE' && p.unexpired === true && p.profile === 'ask-remote-openai-luna-v1' && p.region === 'EU'
  && p.dataClass === 'SYNTHETIC' && p.promptSha256 === PROMPT_SHA256 && p.schemaSha256 === SCHEMA_SHA256 && p.packageSha256 === DESIGN_PACKAGE_SHA256
  && p.reserveMicroUsd === '300000';

/** Consent tuple FIRST (a fresh fence never cures a stale policyVersion), then the active policy and the exact client admission. */
async function admittedPolicy(sql: PhaseSql, scope: Scope, consent: AskRemoteAcknowledgement): Promise<PolicyRow> {
  const policy = await readPolicy(sql, scope.workspaceId);
  if (policy === null) return fail('ASK_REMOTE_NOT_ADMITTED');
  if (policy.admissionId !== consent.admissionId || policy.policyVersion !== consent.policyVersion) return fail('ASK_REMOTE_POLICY_CHANGED');
  if (!active(policy)) return fail('ASK_REMOTE_NOT_ADMITTED');
  const client = await sql(tx => tx.$queryRawUnsafe<{ state: string }[]>(CLIENT_SQL, scope.workspaceId, policy.admissionId, scope.clientId));
  if (client.length !== 1 || client[0]!.state !== 'ADMITTED') return fail('ASK_REMOTE_NOT_ADMITTED');
  return policy;
}
/** The policy captured in phase1 is still exactly current (tuple, price revision and secret binding). */
async function capturedPolicy(sql: PhaseSql, scope: Scope, captured: RemotePolicyView): Promise<void> {
  const policy = await admittedPolicy(sql, scope, captured);
  if (policy.priceRevision !== captured.priceRevision || policy.secretRef !== captured.secretRef) fail('ASK_REMOTE_POLICY_CHANGED');
}
const scoped = (sql: PhaseSql, scope: Scope) => sql(tx => setLocal(tx, { 'app.workspace_id': scope.workspaceId, 'app.client_ids': scope.clientId }));

export function dbRemotePort(db: PrismaClient): RemoteAskPort {
  const base = dbAskPort(db);
  return Object.freeze({
    sourceMode: 'db' as const,
    credential: base.credential,
    authenticate: base.authenticate,
    async capability(run: AskRun, identity: AskIdentity, credential: AskCredential): Promise<AskRemoteAcknowledgement> {
      const hash = digestOf(credential);
      return remoteTx(db, run, 'admit', async sql => {
        await clearSettings(sql);
        if (!await stillCurrent(sql, hash, identity)) askFailure('ASK_AUTHENTICATION_FAILED');
        await sql(tx => setLocal(tx, { 'app.workspace_id': identity.workspaceId }));
        const policy = await readPolicy(sql, identity.workspaceId);
        sql.check();
        if (policy === null || !active(policy)) return fail('ASK_REMOTE_NOT_ADMITTED');
        return Object.freeze({ admissionId: policy.admissionId, policyVersion: policy.policyVersion });
      });
    },
    async admit(run, identity, credential, clientId, focusId, consent, allows, evaluation): Promise<RemoteAdmission> {
      const hash = digestOf(credential);
      const scope = Object.freeze({ workspaceId: identity.workspaceId, clientId });
      const outcome = await remoteTx(db, run, 'admit', async sql => {
        const authority = await fencedAuthority(sql, run, identity, hash, clientId, ASK_REMOTE_PERMISSIONS);
        if ('refused' in authority) return authority;
        await scoped(sql, scope);
        const policy = await admittedPolicy(sql, scope, consent);
        if (!allows(scope.workspaceId, BigInt(policy.policyVersion))) fail('ASK_REMOTE_UNAVAILABLE');
        // Rolling admission is charged only here: positive authority and admission, immediately before the source read.
        sql.check();
        if (!run.owner.charge()) askFailure('ASK_BUSY');
        // R-EVAL RS-C-A: only a claimed registered-sandbox task supplies phases; its pinned reference reaches resource freshness only.
        const sourceNow = evaluation ? await evaluation.phase1(sql, scope) : authority.now;
        const source = await readDbSource(sql, scope, focusId, sourceNow);
        sql.check();
        return { epoch: authority.epoch, source, policy: Object.freeze({ admissionId: policy.admissionId, policyVersion: policy.policyVersion,
          priceRevision: policy.priceRevision, secretRef: policy.secretRef }) };
      });
      if ('refused' in outcome) askFailure(outcome.refused);
      return Object.freeze({ scope, epoch: outcome.epoch, source: outcome.source, policy: outcome.policy,
        consent: Object.freeze({ admissionId: consent.admissionId, policyVersion: consent.policyVersion }) });
    },
    async egress(run, identity, credential, admission, prepared, evaluation): Promise<DispatchCapability> {
      run.check();
      if (run.deadline.remaining() < EGRESS_FLOOR_MS) askFailure('ASK_DEADLINE');
      const hash = digestOf(credential);
      const { scope, policy } = admission;
      const ms = run.deadline.phase(ASK_LIMITS.phaseMs);
      return admitEgress(async () => {
        const result = await phaseTx(db, run, ms, work => run.owner.hold(work), async sql => {
          const authority = await fencedAuthority(sql, run, identity, hash, scope.clientId, ASK_REMOTE_PERMISSIONS);
          if ('refused' in authority) return authority;
          if (authority.epoch !== admission.epoch) askFailure('ASK_SCOPE_CHANGED');
          await scoped(sql, scope);
          await capturedPolicy(sql, scope, policy);
          if (evaluation) await evaluation.recheck(sql, scope);
          const sample = await sql(tx => tx.$queryRawUnsafe<{ now: string }[]>(CLOCK_SQL));
          // Measured AFTER the sample returned, so the DB-clock floor (sample + this margin) is never later than the real one.
          const remaining = Math.floor(run.deadline.remaining());
          if (remaining < EGRESS_FLOOR_MS || sample.length !== 1) askFailure('ASK_DEADLINE');
          const rows = await sql(tx => tx.$queryRawUnsafe<{ attemptId: string }[]>(RESERVE_FLOOR_SQL, ...reserveFloorParams({ workspaceId: scope.workspaceId,
            clientId: scope.clientId, actorId: identity.actorId, admissionId: admission.consent.admissionId, policyVersion: admission.consent.policyVersion,
            fenceVersion: Number(authority.epoch), priceRevision: policy.priceRevision, correlationId: run.correlationId },
          { sample: sample[0]!.now, aboveMs: remaining - EGRESS_FLOOR_MS })));
          // After the INSERT and all its waits, immediately before return: DB-clock credential and policy, original floor.
          if (!await stillCurrent(sql, hash, identity)) askFailure('ASK_AUTHENTICATION_FAILED');
          await capturedPolicy(sql, scope, policy);
          if (rows.length !== 1 || run.deadline.remaining() < EGRESS_FLOOR_MS) askFailure('ASK_DEADLINE');
          sql.check();
          return { attemptId: rows[0]!.attemptId };
        }, (error, committed) => committed ? new EgressUnknown() : failureOf('admit')(error, false));
        if ('refused' in result) return askFailure(result.refused);
        return { attempt: { workspaceId: scope.workspaceId, clientId: scope.clientId, attemptId: result.attemptId, correlationId: run.correlationId,
          admissionId: policy.admissionId, policyVersion: policy.policyVersion }, secretRef: policy.secretRef };
      }, prepared, run.signal);
    },
    async settle(hold, capability): Promise<void> {
      const taken = takeSettlement(capability);
      if (taken === null) throw new Error('ASK_REMOTE_SETTLEMENT_TAKEN');
      const { attempt, outcome, usage } = taken;
      await phaseTx(db, DRAIN, SETTLEMENT_PHASE_MS, hold, async sql => {
        await clearSettings(sql);
        await scoped(sql, attempt);
        await sql(tx => tx.$queryRawUnsafe(SETTLE_SQL, ...settleParams({ workspaceId: attempt.workspaceId, clientId: attempt.clientId,
          attemptId: attempt.attemptId, correlationId: attempt.correlationId, outcome, usage })));
        sql.check();
      }, (_error, committed) => committed ? new SettlementUnknown() : new Error('ASK_REMOTE_SETTLEMENT_FAILED'));
    },
    async pause(hold, attempt, reason): Promise<bigint> {
      const rows = await phaseTx(db, DRAIN, PAUSE_PHASE_MS, hold, async sql => {
        await clearSettings(sql);
        await sql(tx => setLocal(tx, { 'app.workspace_id': attempt.workspaceId }));
        const out = await sql(tx => tx.$queryRawUnsafe<{ policyVersion: string }[]>(PAUSE_SQL, ...pauseParams({ workspaceId: attempt.workspaceId,
          admissionId: attempt.admissionId, reason })));
        sql.check();
        return out;
      }, () => new Error('ASK_REMOTE_PAUSE_FAILED'));
      return BigInt(rows[0]!.policyVersion);
    },
    async publish(run, identity, credential, admission, outcome, evaluation): Promise<void> {
      const hash = digestOf(credential);
      const { scope } = admission;
      const result = await remoteTx(db, run, 'publish', async sql => {
        const authority = await fencedAuthority(sql, run, identity, hash, scope.clientId, ASK_REMOTE_PERMISSIONS);
        if ('refused' in authority) return authority;
        if (authority.epoch !== admission.epoch) askFailure('ASK_SCOPE_CHANGED');
        await scoped(sql, scope);
        await capturedPolicy(sql, scope, admission.policy);
        if (evaluation) await evaluation.recheck(sql, scope);
        const record = remoteAuditRecord(outcome);
        try {
          await sql(tx => tx.auditEvent.create({ data: clientAuditData(scope, identity.actorId, record.eventType, run.correlationId, record.metadata),
            select: { id: true } }));
        } catch (error) { if (decidedCode(error) !== null || error instanceof AskStopped) throw error; askFailure('ASK_AUDIT_FAILED'); }
        // After the INSERT and all its waits, immediately before the transaction returns: DB-clock token, policy and deadline.
        if (!await stillCurrent(sql, hash, identity)) askFailure('ASK_AUTHENTICATION_FAILED');
        await capturedPolicy(sql, scope, admission.policy);
        sql.check();
        return { published: true as const };
      });
      if ('refused' in result) askFailure(result.refused);
    }
  } satisfies RemoteAskPort);
}
