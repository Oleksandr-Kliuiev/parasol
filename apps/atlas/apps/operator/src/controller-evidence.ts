// Stored-evidence reads for the selected observation (S5-B brief, Fixed operations and evidence binding). DOM-free.
// Only a deliberate request() can send, never selection, context or queue loading. Each request has a fresh request ID.
// A completion changes state only while the credential, scope, evidence generation, selected observation and its exact
// source tuple are all still the captured ones; anything else is stale and ignored, whether or not abort was honoured.
import { evidenceOperation, planEvidence, sameTarget } from './evidence-plan.ts';
import type { ObservationItem } from './contracts.ts';
import { PanelWork } from './panels.ts';
import type { Kernel } from './panels.ts';
import { failed, loading, ready } from './state.ts';
import type { ConsoleState } from './state.ts';
import { executeValidated } from './transport.ts';
import { validateEvidence } from './validate-evidence.ts';

export interface EvidenceController {
  request(): void;
  /** Invalidates any pending evidence read (selection, page, scope or credential change). */
  reset(): void;
}

/** The currently selected observation of the current queue page, or null. */
export function selectedObservation(state: ConsoleState): ObservationItem | null {
  if (state.observationId === null || state.queue.status !== 'READY' || !state.queue.data) return null;
  return state.queue.data.items.find(item => item.id === state.observationId) ?? null;
}

export function createEvidenceController(kernel: Kernel): EvidenceController {
  const work = new PanelWork();
  const requestId = kernel.options.requestId ?? (() => crypto.randomUUID());
  return Object.freeze({
    reset: () => work.reset(),
    request(): void {
      const state = kernel.state();
      const context = state.context.status === 'READY' ? state.context.data : null;
      const item = selectedObservation(state);
      if (!context || !item || !state.selection || context.clientId !== state.selection.clientId) return;
      // One pending read per selection: a repeated click while it is pending sends nothing; retry follows completion.
      if (state.evidence.status === 'LOADING') return;
      const plan = planEvidence(item, state.selection.clientId, context.mode);
      if (plan.kind !== 'request') return;
      const target = plan.target;
      const workspaceId = context.workspaceId;
      const inScope = kernel.scope();
      const pending = work.start();
      kernel.set({ evidence: loading() });
      void executeValidated(kernel.holder, evidenceOperation(target, requestId()), pending.signal,
        (value, headers) => validateEvidence(value, headers, target, workspaceId), kernel.options).then(result => {
        const now = kernel.state();
        if (!inScope() || !pending.current() || !sameTarget(target, selectedObservation(now), now.selection?.clientId ?? null)) return;
        if (!result.ok && kernel.denied(result.code)) return;
        kernel.set({ evidence: result.ok ? ready(result.value) : failed(result.code) });
      });
    }
  });
}
