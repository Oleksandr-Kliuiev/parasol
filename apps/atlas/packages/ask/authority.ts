import type { PrismaClient } from '@prisma/client';
import { currentToken, setLocal } from '../auth/transaction-token.ts';
import { clientAuditData } from '../audit/prisma.ts';
import { askFailure, isAskFailure } from './contracts.ts';
import { bearerCredential } from './credential.ts';
import type { AskCredential } from './credential.ts';
import { askAuditRecord } from './audit.ts';
import type { AskAuditOutcome } from './audit.ts';
import { readDbSource } from './read.ts';
import { boundedTx, clearSettings, currentActor, digestOf, fencedAuthority, stillCurrent } from './db-phase.ts';
import { AskStopped } from './service.ts';
import type { AskAdmission, AskIdentity, AskPort, AskRun } from './service.ts';

/**
 * DB Ask port (docs/stage5/ask/03 "Current bearer and client authority"), confined runtime role, READ COMMITTED.
 *
 * Every phase is ONE bounded transaction with ONE absolute end fixed at its start, min(2 s, remaining original budget):
 * pool maxWait ≤min(500 ms, phase), transaction timeout = phase, and before EVERY statement the transaction-local
 * statement_timeout is re-bounded to the time left in the phase (phase.ts), so sequential lock waits share one budget.
 * The caller sees ASK_DEADLINE at the phase end; capacity is NOT released then: the owner keeps its slot until BOTH the
 * transaction promise and its callback have actually settled, and a stopped phase issues no further statement.
 *
 * Private authentication: settings cleared, digest-only current-token lookup with the DB clock, then the ACTIVE actor —
 * no memberships, permissions or client data. Phase1/phase2 (fencedAuthority): settings cleared → current-token hint →
 * app.workspace_id = hint BEFORE the FIRST lock: ActionAuthorityFence FOR SHARE (an Ask-only shared read admission; frozen
 * Stage 3 actions keep FOR UPDATE) → fence readiness → after the lock: current token with the DB clock, SAME workspace AND
 * actor as private authentication, ACTIVE actor, one membership of the path client with context:read → else exactly one
 * workspace `ask.scope_denied` (post-INSERT expiry/deadline checks) → one-client scope. Fence version is the exact DB
 * integer as text. Phase2 is bound to the captured workspace/client/actor/credential: rebinding → 401, scope lost → 403,
 * epoch changed → 409 without audit; the final audit INSERT is followed by DB-clock expiry and original-deadline checks
 * immediately before the transaction returns, so expiry/deadline rolls the audit back. No lock survives a phase.
 */
// rc2 (R1/R2): every phase has ONE absolute end; every statement runs through phaseSql (checks + remaining-budget timeout).
// The bounded phase, private authentication helpers and fenced authority live in db-phase.ts (shared with ASK-REMOTE).

export function dbAskPort(db: PrismaClient): AskPort {
  return Object.freeze({
    sourceMode: 'db' as const,
    credential: bearerCredential,
    async authenticate(run: AskRun, credential: AskCredential): Promise<AskIdentity | null> {
      const hash = digestOf(credential);
      return boundedTx(db, run, 'authenticate', async sql => {
        await clearSettings(sql);
        const token = await sql(tx => currentToken(tx, hash));
        if (!token) return null;
        const actor = await currentActor(sql, token.workspaceId, token.actorId, false);
        return actor ? Object.freeze({ workspaceId: token.workspaceId, actorId: token.actorId }) : null;
      });
    },
    async admit(run: AskRun, identity: AskIdentity, credential: AskCredential, clientId: string, focusId: string | null): Promise<AskAdmission> {
      const hash = digestOf(credential);
      const scope = Object.freeze({ workspaceId: identity.workspaceId, clientId });
      const outcome = await boundedTx(db, run, 'admit', async sql => {
        const authority = await fencedAuthority(sql, run, identity, hash, clientId);
        if ('refused' in authority) return authority;
        // Rolling admission is charged only here: positive phase1 authority, immediately before the source read.
        sql.check();
        if (!run.owner.charge()) askFailure('ASK_BUSY');
        await sql(tx => setLocal(tx, { 'app.workspace_id': identity.workspaceId, 'app.client_ids': clientId }));
        const source = await readDbSource(sql, scope, focusId, authority.now);
        sql.check();
        return { epoch: authority.epoch, source };
      });
      if ('refused' in outcome) askFailure(outcome.refused);
      return Object.freeze({ scope, epoch: outcome.epoch, source: outcome.source });
    },
    async publish(run: AskRun, identity: AskIdentity, credential: AskCredential, admission: AskAdmission, outcome: AskAuditOutcome): Promise<void> {
      const hash = digestOf(credential);
      const result = await boundedTx(db, run, 'publish', async sql => {
        const authority = await fencedAuthority(sql, run, identity, hash, admission.scope.clientId);
        if ('refused' in authority) return authority;
        if (authority.epoch !== admission.epoch) askFailure('ASK_SCOPE_CHANGED');
        await sql(tx => setLocal(tx, { 'app.workspace_id': identity.workspaceId, 'app.client_ids': admission.scope.clientId }));
        const record = askAuditRecord(outcome);
        try {
          await sql(tx => tx.auditEvent.create({ data: clientAuditData(admission.scope, identity.actorId, record.eventType, run.correlationId, record.metadata),
            select: { id: true } }));
        } catch (error) { if (isAskFailure(error) || error instanceof AskStopped) throw error; askFailure('ASK_AUDIT_FAILED'); }
        // After the INSERT and all its waits, immediately before the transaction returns: DB-clock expiry, original deadline.
        if (!await stillCurrent(sql, hash, identity)) askFailure('ASK_AUTHENTICATION_FAILED');
        sql.check();
        return { published: true as const };
      });
      if ('refused' in result) askFailure(result.refused);
    }
  });
}
