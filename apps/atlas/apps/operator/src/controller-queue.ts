// Observation queue of the selected client (docs/stage5/02_CONTRACTS.md, Observation defaults). DOM-free.
// A queue request starts only after the context validated the current workspace/client. Every filter, page and refresh
// request first clears the page, the selected observation and its evidence; the next page REPLACES the current one, so at
// most one page is retained. Fixture contexts have the fixed demo page only: filter and paging input is refused locally.
import type { EvidenceController } from './controller-evidence.ts';
import type { QueuePosition } from './contracts.ts';
import { PanelWork } from './panels.ts';
import type { Kernel } from './panels.ts';
import { FIRST_PAGE, queueQuery } from './queue-query.ts';
import { failed, idle, loading, ready } from './state.ts';
import { getValidated } from './transport.ts';
import { validatePage } from './validate-observations.ts';

export interface QueueController {
  load(position: QueuePosition): void;
  /** DB only: applies a selection built from operator input and loads its first page. False when refused (no request). */
  apply(statuses: readonly unknown[], severities: readonly unknown[], limit: unknown): boolean;
  refresh(): void;
  next(): void;
  first(): void;
  retry(): void;
  select(observationId: string): void;
  reset(): void;
}

/** Dependents told synchronously about queue (load/filter/page/refresh/refusal/reset) and selection changes: Ask Atlas. */
export interface QueueHooks { queueChanged(): void; selectionChanged(): void }

export function createQueueController(kernel: Kernel, evidence: EvidenceController, hooks: QueueHooks): QueueController {
  const work = new PanelWork();
  const currentContext = () => {
    const state = kernel.state();
    const context = state.context.status === 'READY' ? state.context.data : null;
    return context && state.selection && context.clientId === state.selection.clientId ? context : null;
  };
  /** Unsupported fixture filter/page input: refused as RESPONSE_INVALID, never sent and never silently ignored. */
  const refuse = () => {
    work.reset(); evidence.reset(); hooks.queueChanged();
    kernel.set({ queue: failed('RESPONSE_INVALID'), observationId: null, evidence: idle() });
  };

  function load(position: QueuePosition): void {
    const context = currentContext();
    if (!context) return;
    const query = kernel.state().queueQuery;
    const scope = { workspaceId: context.workspaceId, clientId: context.clientId };
    const inScope = kernel.scope();
    const pending = work.start();
    evidence.reset(); hooks.queueChanged();
    kernel.set({ queuePosition: position, queue: loading(), observationId: null, evidence: idle() });
    const page = context.mode === 'fixture' ? null : { query, cursor: position.cursor };
    const rule = context.mode === 'fixture' ? { mode: 'fixture' as const } : { mode: 'db' as const, query };
    void getValidated(kernel.holder, { kind: 'observations', clientId: context.clientId, page }, pending.signal,
      value => validatePage(value, scope, rule), kernel.options).then(result => {
      if (!inScope() || !pending.current()) return;
      if (!result.ok && kernel.denied(result.code)) return;
      kernel.set({ queue: result.ok ? ready(result.value) : failed(result.code) });
    });
  }

  return Object.freeze({
    load,
    apply(statuses: readonly unknown[], severities: readonly unknown[], limit: unknown): boolean {
      const context = currentContext();
      if (!context) return false;
      if (context.mode === 'fixture') { refuse(); return false; }
      const query = queueQuery(statuses, severities, limit);
      if (!query) return false;
      kernel.set({ queueQuery: query });
      load(FIRST_PAGE);
      return true;
    },
    refresh: () => load(FIRST_PAGE),
    next(): void {
      const context = currentContext();
      const state = kernel.state();
      if (!context) return;
      if (context.mode === 'fixture') return refuse();
      const cursor = state.queue.status === 'READY' ? state.queue.data?.nextCursor ?? null : null;
      if (cursor !== null) load({ cursor, number: state.queuePosition.number + 1 });
    },
    first(): void {
      const context = currentContext();
      if (!context) return;
      if (context.mode === 'fixture') return refuse();
      load(FIRST_PAGE);
    },
    retry(): void { if (kernel.state().queue.status === 'ERROR') load(kernel.state().queuePosition); },
    select(observationId: string): void {
      const state = kernel.state();
      if (state.queue.status !== 'READY' || !state.queue.data?.items.some(item => item.id === observationId)) return;
      if (state.observationId === observationId) return;
      evidence.reset(); hooks.selectionChanged();
      kernel.set({ observationId, evidence: idle() });
    },
    reset(): void { work.reset(); evidence.reset(); hooks.queueChanged(); }
  });
}
