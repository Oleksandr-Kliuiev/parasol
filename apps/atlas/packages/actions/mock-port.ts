import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { TICKET_ID_PATTERN, actionError } from './contracts.ts';
import { isUuid } from './canonical.ts';
import { setLocal } from './authority.ts';

/**
 * Internal synthetic ticket port (docs/stage3/04_EXECUTION_AND_PORT.md "Internal port, not vendor wire schema"). Not a
 * vendor wire contract and not a transport: no method, URL, header, credential, origin or callback exists here. The only
 * implementation is the built-in ActionMockTicket store of the trusted MOCK composition, bound to one scoped atera FIXTURE
 * Connection. Each create is its own independent scoped commit of an immutable S3_SYNTHETIC row (no deduplication by
 * marker or nonce); a read returns only the whitelisted fields of the exact bound Connection's row. These rows are never
 * ExternalEntity/RawEvent/ResourceSnapshot, baseline context or live evidence. No native network module is used.
 *
 * The execution services take an ActionPorts value as a trusted in-process dependency: the operator CLI always composes
 * mockActionPorts(db); no environment variable, flag or file selects a port (policy.ts refuses those). Tests wrap this
 * port to inject bounded faults (tests/support), never production code.
 *
 * Cancellation (04 "Create has a 15-second AbortSignal deadline. Port must honor it"): every invocation carries its
 * AbortSignal and the monotonic instant at which that signal fires. The built-in store binds ALL of its database work to
 * that ORIGINAL instant — never to a fresh window: no pool wait or transaction once it has passed or the signal fired;
 * pool acquisition (maxWait) and the transaction lifetime are capped by the time remaining at the call; after acquiring a
 * connection the remaining time is re-read and becomes the transaction's statement_timeout, so a statement blocked on a
 * lock is cancelled by PostgreSQL itself at the deadline; and the signal/deadline is re-checked after the statement, before
 * COMMIT, so cancelled work rolls back instead of committing. The returned promise settles only after the transaction has
 * committed or rolled back: a rejection never leaves a synthetic write running. Only the irreducible window between that
 * last check and the COMMIT acknowledgement stays ambiguous, which execution.ts treats as OUTCOME_UNKNOWN (no retry).
 */
export interface PortBinding { readonly workspaceId: string; readonly clientId: string; readonly connectionId: string }
/** createOne input: the immutable normalized customer key, marked title, description and the attempt's create nonce. */
export interface CreateTicket { readonly customerKey: string; readonly markedTitle: string; readonly description: string; readonly nonce: string }
/** readOne input: the exact bound Connection and one bounded ticket ID. */
export interface ReadTicket { readonly connectionId: string; readonly ticketId: string }
/** The whitelisted read result. Anything else from a port is malformed (execution treats it as a failed read). */
export interface TicketRecord { ticketId: string; customerKey: string; markedTitle: string; description: string; synthetic: true }
/** Invocation control: the AbortSignal and the performance.now() instant at which it fires (the invocation's deadline). */
export interface PortCall { readonly signal: AbortSignal; readonly deadline: number }
export interface TicketPort {
  /** Returns only the bounded ticket ID. Must honor the call; a result after it fired is a late observation. */
  createOne(input: CreateTicket, call: PortCall): Promise<string>;
  /** null when the bound Connection holds no such ticket. */
  readOne(input: ReadTicket, call: PortCall): Promise<TicketRecord | null>;
}
export interface ActionPorts { ticketPort(binding: PortBinding): TicketPort }

const remaining = (call: PortCall): number => Math.floor(call.deadline - performance.now());
const cancelled = (call: PortCall): boolean => call.signal.aborted || remaining(call) <= 0;

/** The built-in synthetic store on the confined runtime client, under an explicit workspace/client scope per commit. */
export function mockActionPorts(db: PrismaClient): ActionPorts {
  return Object.freeze({
    ticketPort(binding: PortBinding): TicketPort {
      /** One transaction bounded by the invocation's ORIGINAL deadline (see the module comment); any failure is fixed. */
      const bounded = async <T>(call: PortCall, failure: 'ACTION_OUTCOME_UNKNOWN' | 'ACTION_VERIFICATION_FAILED',
        fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
        const window = remaining(call);
        if (cancelled(call)) throw actionError(failure); // no pool wait, no statement
        try {
          return await db.$transaction(async tx => {
            const left = remaining(call);
            if (cancelled(call)) throw actionError(failure); // the pool wait used the window: nothing executed
            await setLocal(tx, { statement_timeout: String(left), 'app.token_hash': '', 'app.actor_id': '', 'app.workspace_id': binding.workspaceId,
              'app.client_ids': binding.clientId });
            const result = await fn(tx);
            if (cancelled(call)) throw actionError(failure); // never COMMIT after cancellation: roll back instead
            return result;
          }, { maxWait: window, timeout: window });
        } catch { throw actionError(failure); }
      };
      return Object.freeze({
        async createOne(input: CreateTicket, call: PortCall): Promise<string> {
          const id = randomUUID();
          await bounded(call, 'ACTION_OUTCOME_UNKNOWN', tx => tx.actionMockTicket.create({ data: { workspaceId: binding.workspaceId, clientId: binding.clientId,
            connectionId: binding.connectionId, id, customerKey: input.customerKey, markedTitle: input.markedTitle, description: input.description },
            select: { id: true } }));
          return id;
        },
        async readOne(input: ReadTicket, call: PortCall): Promise<TicketRecord | null> {
          if (cancelled(call) || input.connectionId !== binding.connectionId || !TICKET_ID_PATTERN.test(input.ticketId)) throw actionError('ACTION_VERIFICATION_FAILED');
          if (!isUuid(input.ticketId)) return null; // the built-in store mints UUIDs only: no such ticket here
          const row = await bounded(call, 'ACTION_VERIFICATION_FAILED', tx => tx.actionMockTicket.findUnique({ where: { workspaceId_clientId_connectionId_id: {
            workspaceId: binding.workspaceId, clientId: binding.clientId, connectionId: binding.connectionId, id: input.ticketId } },
            select: { id: true, synthetic: true, customerKey: true, markedTitle: true, description: true } }));
          if (!row || row.synthetic !== 'S3_SYNTHETIC') return null;
          return { ticketId: row.id, customerKey: row.customerKey, markedTitle: row.markedTitle, description: row.description, synthetic: true };
        },
      });
    },
  });
}
