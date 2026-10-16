import { FixtureDecisionProvider } from '../packages/decisions/provider.ts';
import { ReferencePipeline } from '../packages/events/pipeline.ts';
import { MemoryAudit, MemorySecurityAudit } from '../packages/audit/memory.ts';
import { normalizeAtera } from '../connectors/atera/normalizer.ts';
import { normalizeHuntress } from '../connectors/huntress/normalizer.ts';
import { scope, actor, people, devices, links } from './gasta.ts';
import type { ClientContextV1, ObservationPage, ResourceView, Severity } from '../packages/core/contracts.ts';
import { emptyCounts, severityRank, toObservationSummary } from '../packages/core/contracts.ts';

export interface DemoResult { context: ClientContextV1; pipeline: ReferencePipeline; audit: MemoryAudit; securityAudit: MemorySecurityAudit }

/** Fixture composition of the reference pipeline. Shared by the CLI (scripts/demo.ts), the NestJS fixture API and the tests. */
export async function runDemo(): Promise<DemoResult> {
  const audit = new MemoryAudit();
  const securityAudit = new MemorySecurityAudit();
  const pipeline = new ReferencePipeline(new FixtureDecisionProvider(), links, audit);
  const at = '2026-10-07T07:00:00.000Z';
  const alert = normalizeAtera(scope, 'demo-atera-connection',
    { id: 'demo-alert-1', revision: '1', agentId: 'demo-atera-agent-107', at, diskPercent: 96, severity: 'MEDIUM' }, at);
  const incident = normalizeHuntress(scope, 'demo-huntress-connection',
    { id: 'demo-incident-1', revision: '1', agentId: 'demo-huntress-agent-207', at, signal: 'Possible credential theft (synthetic)', severity: 'CRITICAL' }, at);
  await pipeline.ingest(actor, alert, 'demo-correlation-1');
  await pipeline.ingest(actor, incident, 'demo-correlation-2');

  // Same order as the DB query: urgent first, then newest, then a stable tiebreak on id.
  const observations = pipeline.list(scope).map(toObservationSummary)
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const counts = emptyCounts();
  for (const o of observations) counts[o.severity as Severity] += 1;
  const page: ObservationPage = { items: observations, counts, total: observations.length, truncated: false, nextCursor: null };
  const fixture = (source: ResourceView['source'], resourceType: ResourceView['resourceType'], connectionId: string, items: unknown[]): ResourceView =>
    ({ source, resourceType, connectionId, status: 'FIXTURE', asOf: at, lastSuccessAt: at, safeErrorCode: null, items, truncated: false });
  const context: ClientContextV1 = { ...scope, contractVersion: 'ClientContextV1', mode: 'fixture', clientName: 'Gasta (synthetic)',
    people, devices, links, observations: page,
    resources: [
      fixture('atera', 'alert', 'demo-atera-connection', [alert]),
      fixture('atera', 'ticket', 'demo-atera-connection', [{ id: 'demo-ticket-1', status: 'OPEN', title: 'Disk capacity follow-up (synthetic)' }]),
      fixture('huntress', 'incident', 'demo-huntress-connection', [incident])
    ],
    generatedAt: new Date().toISOString(), completeness: 'COMPLETE_FIXTURE' };
  return { context, pipeline, audit, securityAudit };
}
