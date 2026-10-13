// POST /tools/execute → ResourceView evidence for one selected observation (S5-B brief, Fixed operations). DOM-free.
// Accepted only when the view is the captured source/resource/connection (no null-connection fallback) and every item is
// the reviewed shape for the captured mode. A get result must contain only the selected ID; a list result is filtered to it
// exactly, keeping the original truncation. Diagnostic headers are kept only as opaque bounded IDs.
import { DIAGNOSTIC_ID_PATTERN } from './contracts.ts';
import type { EvidenceTarget } from './evidence-plan.ts';
import type { EvidenceView } from './contracts.ts';
import { fail } from './validate-core.ts';
import type { Scope } from './validate-observations.ts';
import { storedId, validateResource } from './validate-resources.ts';

const diagnostic = (headers: Headers, name: string): string | null => {
  const value = headers.get(name);
  return value !== null && DIAGNOSTIC_ID_PATTERN.test(value) ? value : null;
};

export function validateEvidence(value: unknown, headers: Headers, target: EvidenceTarget, workspaceId: string): EvidenceView {
  const scope: Scope = { workspaceId, clientId: target.clientId };
  const view = validateResource(value, target.mode, scope);
  if (view.source !== target.source || view.resourceType !== target.resourceType || view.connectionId !== target.connectionId) fail();
  let items = view.items;
  if (items !== null) {
    if (target.tool === 'atera.alert.list') items = Object.freeze(items.filter(item => storedId(item) === target.sourceId));
    else if (items.some(item => storedId(item) !== target.sourceId)) fail();
  }
  return Object.freeze({
    observationId: target.observationId, tool: target.tool, mode: target.mode, status: view.status, asOf: view.asOf,
    lastSuccessAt: view.lastSuccessAt, truncated: view.truncated, readCount: view.items === null ? null : view.items.length, items,
    correlationId: diagnostic(headers, 'x-atlas-correlation-id'), executionId: diagnostic(headers, 'x-atlas-tool-execution-id')
  });
}
