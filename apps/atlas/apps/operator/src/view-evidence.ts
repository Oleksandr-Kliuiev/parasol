// Evidence result for the selected observation. Read status and its own two times, truncation and absence semantics:
// empty means only "not in this stored read" (and possibly beyond it when truncated); ERROR/MISSING are unavailable, never
// empty. Optional diagnostic IDs are opaque text. No safeErrorCode, body, raw JSON or source hyperlink is shown.
import { button, el } from './dom.ts';
import { EVIDENCE_NOT_FOUND, EVIDENCE_NOT_FOUND_TRUNCATED, NOT_ATOMIC_TEXT } from './messages.ts';
import type { EvidenceView } from './contracts.ts';
import { code, failureNotice, fields, readStatus, storedItems } from './view-parts.ts';
import type { Controller } from './controller.ts';
import type { Panel } from './state.ts';

export function evidenceStatus(evidence: Panel<EvidenceView>): string {
  if (evidence.status === 'LOADING') return 'Reading stored evidence…';
  if (evidence.status === 'ERROR' && evidence.error) return `Evidence unavailable (${evidence.error}).`;
  if (evidence.status === 'READY' && evidence.data) {
    const items = evidence.data.items;
    return items === null ? `Stored read ${evidence.data.status}: unavailable.` : `Stored read ${evidence.data.status}: ${items.length} matching item${items.length === 1 ? '' : 's'}.`;
  }
  return '';
}

/** `actionable` is false when the selection has no allowlisted read (no button, so no hint about pressing one). */
export function evidenceBody(evidence: Panel<EvidenceView>, controller: Controller, actionable: boolean): Node[] {
  if (evidence.status === 'ERROR' && evidence.error) {
    return [failureNotice(evidence.error), button('Retry evidence', 'btn btn-secondary', () => controller.requestEvidence())];
  }
  const view = evidence.status === 'READY' ? evidence.data : null;
  if (!view) return evidence.status === 'IDLE' && actionable ? [el('p', 'muted', 'Evidence is read only when you press the button above.')] : [];
  const out: Node[] = [el('p', 'evidence-tool', 'Result of ', code(view.tool))];
  const diagnostics: [string, Node][] = [];
  if (view.correlationId !== null) diagnostics.push(['Correlation ID', code(view.correlationId)]);
  if (view.executionId !== null) diagnostics.push(['Tool execution ID', code(view.executionId)]);
  out.push(...readStatus(view));
  if (view.items !== null) {
    if (view.items.length === 0) out.push(el('p', 'notice notice-warning', view.truncated ? EVIDENCE_NOT_FOUND_TRUNCATED : EVIDENCE_NOT_FOUND));
    else out.push(...storedItems(view.items));
    if (view.tool === 'atera.alert.list' && view.readCount !== null) {
      out.push(el('p', 'muted small', `Items in this stored read matching the selected source ID exactly: ${view.items.length} of ${view.readCount}.`));
    }
  }
  if (diagnostics.length) out.push(fields(diagnostics, 'fields fields-compact'));
  out.push(el('p', 'muted small', NOT_ATOMIC_TEXT));
  return out;
}
