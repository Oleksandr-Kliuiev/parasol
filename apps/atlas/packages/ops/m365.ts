import { AtlasError } from '../core/contracts.ts';
import { disableM365Connection } from '../connections/m365-disable.ts';
import type { CursorKeyProvider } from '../correlation/cursor.ts';
import { millisecondInstant } from '../correlation/parameters.ts';
import { readCorrelation } from '../correlation/read.ts';
import { issueM365ActivationCapability, runM365Activation } from '../m365/activation.ts';
import { syncM365Directory } from '../m365/directory.ts';
import { resetM365DirectoryRetry } from '../m365/directory-retry.ts';
import { runM365SignInRequest } from '../m365/ingest.ts';
import type { RootResult } from '../m365/ingest.ts';
import type { Clock, M365Io } from '../m365/io.ts';
import { runM365Cleanup } from '../m365/maintenance.ts';
import type { RuntimeDatabase } from '../m365/maintenance.ts';
import { readDirectory } from '../m365/reads.ts';
import { readM365Status } from '../m365/status-read.ts';
import { createM365SignInRequest, requeueM365RootJob } from '../m365/windows.ts';
import type { ClientCommand, CommandResult, OperatorContext } from './commands.ts';
import { directoryResource, ids, optional, paging, readInterval, RESOURCE, syncMode } from './m365-flags.ts';

/**
 * Microsoft 365 operator commands (03 §6, frozen CLI contract of brief RC3). Thin: the command boundary (commands.ts)
 * checks the client ID and the listed permissions on the authenticated actor (refusal → workspace security audit) and
 * the flag rules at parse time; every command then calls the SAME S2-B/S2-C domain service as the API and tools, which
 * rechecks current authority itself. Sync/requeue/reset reuse the accepted S2-B services (persisted retry/claim/budget,
 * versioned activation) and never sleep, retry internally or start a fresh request to evade retryAt. Output: local IDs,
 * statuses, counts, safe codes; read commands print approved DTOs to the authorized stdout only.
 */
export interface M365OperatorDeps {
  /** The production composition (fixed authority/Graph URLs through fetch, env:// secrets); built on first use. */
  io(): M365Io;
  /** The runtime URL + Prisma pairing from openRuntimeDatabase (the cleanup runner target is derived from it). */
  runtime: RuntimeDatabase;
  env: Readonly<Record<string, string | undefined>>;
  cursorKey: CursorKeyProvider;
  clock?: Clock;
}
const SYNC = ['events:ingest', 'connections:manage'] as const;
const READ = ['context:read', 'm365:read'] as const;
const done = (output: object, ok = true): CommandResult => ({ ok, output: { ...output } });
function deps(ctx: OperatorContext): M365OperatorDeps {
  if (!ctx.m365) throw new AtlasError('M365_NOT_CONFIGURED', 'PERMANENT');
  return ctx.m365;
}
const roots = (results: RootResult[]) => results.map(r => ({ windowId: r.windowId, rootFrom: r.rootFrom.toISOString(), outcome: r.outcome, attemptSeq: r.attemptSeq,
  safeErrorCode: r.safeErrorCode, retryAt: r.retryAt?.toISOString() ?? null, evidenceCount: r.evidenceCount, attemptsUsed: r.attemptsUsed, maxAttempts: r.maxAttempts }));

export const m365Commands: Readonly<Record<string, ClientCommand>> = {
  'm365-disable': { required: ['connection'], permissions: ['connections:manage'],
    run: async (ctx, scope, f) => done(await disableM365Connection(ctx.db, ctx.actor, scope, f.connection!)) },
  'm365-probe': { required: ['connection'], permissions: ['connections:manage'], validate: f => ids(f, 'connection'),
    run: async (ctx, scope, f) => {
      // ACTIVE is refused by the issue step (CONNECTION_ALREADY_ACTIVE) before any I/O; a failed activation stays DISABLED.
      const capability = await issueM365ActivationCapability(ctx.db, ctx.actor, scope, f.connection!, deps(ctx).clock);
      const result = await runM365Activation(ctx.db, ctx.actor, capability, deps(ctx).io(), deps(ctx).clock);
      return done(result, result.status === 'ACTIVE');
    } },
  'm365-sync': { required: ['connection', 'resource'], optional: ['from', 'to', 'request'], permissions: SYNC, validate: f => { syncMode(f); },
    run: async (ctx, scope, f) => {
      const m = deps(ctx); const mode = syncMode(f);
      if (mode === 'directory') {
        const r = await syncM365Directory(ctx.db, ctx.actor, scope, f.connection!, RESOURCE[f.resource!]!, m.io(), m.clock);
        return done({ ...r, retryAt: r.retryAt?.toISOString() ?? null }, r.status === 'PUBLISHED');
      }
      let requestId = f.request!; let created: object = {};
      if (mode === 'create') {
        const request = await createM365SignInRequest(ctx.db, ctx.actor, scope, f.connection!, millisecondInstant(f.from, 'from'), millisecondInstant(f.to, 'to'), m.clock);
        requestId = request.requestId;
        created = { retrievalFrom: request.retrievalFrom?.toISOString() ?? null, retrievalTo: request.retrievalTo?.toISOString() ?? null };
      }
      const results = await runM365SignInRequest(ctx.db, ctx.actor, scope, f.connection!, requestId, m.io(), m.clock);
      return done({ mode, requestId, ...created, roots: roots(results) }, results.every(r => r.outcome !== 'FAILED'));
    } },
  'm365-requeue': { required: ['connection', 'request', 'window'], permissions: SYNC, validate: f => ids(f, 'connection', 'request', 'window'),
    run: async (ctx, scope, f) => done(await requeueM365RootJob(ctx.db, ctx.actor, scope, f.connection!, f.request!, f.window!, deps(ctx).clock)) },
  'm365-directory-reset': { required: ['connection', 'resource'], permissions: SYNC, validate: f => { ids(f, 'connection'); directoryResource(f); },
    run: async (ctx, scope, f) => done(await resetM365DirectoryRetry(ctx.db, ctx.actor, scope, f.connection!, RESOURCE[f.resource!]!, deps(ctx).clock)) },
  'm365-status': { required: ['connection'], optional: ['request'], permissions: ['connections:manage'], validate: f => ids(f, 'connection', 'request'),
    run: async (ctx, scope, f) => done(await readM365Status(ctx.db, ctx.actor, scope, f.connection!, f.request ?? null)) },
  'm365-directory': { required: ['connection', 'resource'], optional: ['limit', 'cursor'], long: ['cursor'], permissions: READ,
    validate: f => { ids(f, 'connection'); directoryResource(f); paging(f); },
    run: async (ctx, scope, f) => done(await readDirectory(ctx.db, ctx.actor, scope, { connectionId: f.connection, resourceType: RESOURCE[f.resource!],
      ...optional(f, { limit: 'limit', cursor: 'cursor' }) }, { cursorKey: deps(ctx).cursorKey })) },
  correlation: { required: ['connection', 'observation', 'from', 'to'], optional: ['limit', 'cursor'], long: ['cursor'], permissions: READ,
    validate: f => { ids(f, 'connection', 'observation'); readInterval(f); paging(f); },
    run: async (ctx, scope, f) => done(await readCorrelation(ctx.db, ctx.actor, scope, { connectionId: f.connection, observationId: f.observation, from: f.from, to: f.to,
      ...optional(f, { limit: 'limit', cursor: 'cursor' }) }, { cursorKey: deps(ctx).cursorKey })) },
  'm365-cleanup': { required: [], permissions: SYNC,
    run: async (ctx, scope) => {
      const result = await runM365Cleanup(deps(ctx).runtime, ctx.actor, scope, { env: deps(ctx).env });
      return done(result, result.status === 'COMPLETED');
    } },
};
