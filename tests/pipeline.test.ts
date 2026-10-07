import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReferencePipeline, eventKey } from '../packages/events/pipeline.ts';
import { FixtureDecisionProvider, RulesDecisionProvider, defaultDecisionConfig } from '../packages/decisions/provider.ts';
import type { DecisionProvider } from '../packages/decisions/provider.ts';
import { normalizeAtera } from '../connectors/atera/normalizer.ts';
import { normalizeHuntress } from '../connectors/huntress/normalizer.ts';
import { scope, actor, links } from '../fixtures/gasta.ts';
import { executeReadTool } from '../packages/tools/gateway.ts';
import { runDemo } from '../fixtures/run-demo.ts';
import { parseRouteResponse, decisionInput, OpenAIDecisionProvider } from '../packages/decisions/openai.ts';
import { resolveDevice } from '../packages/graph/resolver.ts';
import { MemoryAudit, MemorySecurityAudit } from '../packages/audit/memory.ts';
import { auditMetadataAllowlist } from '../packages/audit/sanitize.ts';
import { AtlasError } from '../packages/core/contracts.ts';
import type { Classification, ExternalLink, NormalizedEvent } from '../packages/core/contracts.ts';

const at = '2026-10-07T07:00:00.000Z';
const disk = (severity: 'MEDIUM' | 'CRITICAL' | 'LOW' = 'MEDIUM') => normalizeAtera(scope, 'demo-atera-connection', { id: 'd1', revision: '1', agentId: 'demo-atera-agent-107', at, diskPercent: 96, severity }, at);
const critical = () => normalizeHuntress(scope, 'demo-huntress-connection', { id: 'h1', revision: '1', agentId: 'demo-huntress-agent-207', at, signal: 'Synthetic credential theft', severity: 'CRITICAL' }, at);
const fixed = (c: Partial<Classification>, mode: DecisionProvider['mode'] = 'advisory'): DecisionProvider => ({
  provider: 'openai', mode,
  async classify() { return { route: 'MONITOR', confidence: 0.99, provider: 'openai', reasonCodes: ['MODEL_ROUTE'], promptVersion: 'test', ...c }; }
});
const auditKeys = ['workspaceId', 'clientId', 'id', 'actorId', 'eventType', 'correlationId', 'recordedAt', 'metadata'];

// --- Client graph and context ---------------------------------------------------------------------------------------
test('cross-system context maps both sources to the same canonical device', async () => {
  const { context } = await runDemo();
  assert.equal(context.contractVersion, 'ClientContextV1');
  assert.equal(context.observations.items.length, 2);
  assert.deepEqual(context.observations.items.map(o => o.entityId), ['demo-device-07', 'demo-device-07']);
  assert.equal(context.people[0]?.id, context.devices[0]?.personId);
  assert.deepEqual(context.observations.items.map(o => o.severity), ['CRITICAL', 'MEDIUM'], 'urgent first');
  assert.deepEqual(context.observations.items.map(o => o.domain), ['SECURITY', 'OPERATIONS']);
});
test('resolver requires matching resource type and a DEVICE entity; a person link with the same external ID never resolves', () => {
  const personLink: ExternalLink = { ...scope, connectionId: 'demo-atera-connection', system: 'atera', resourceType: 'contact', externalId: '107', entityId: 'demo-kari', entityKind: 'PERSON', status: 'CONFIRMED' };
  const agentToPerson: ExternalLink = { ...personLink, resourceType: 'agent' };
  const ev = normalizeAtera(scope, 'demo-atera-connection', { id: 'a', revision: '1', agentId: '107', at, diskPercent: 90, severity: 'LOW' }, at);
  assert.equal(resolveDevice(ev, [personLink]), null);
  assert.equal(resolveDevice(ev, [agentToPerson]), null);
  assert.equal(resolveDevice(ev, [{ ...agentToPerson, entityId: 'demo-device-07', entityKind: 'DEVICE' }]), 'demo-device-07');
});

// --- Identity and deduplication -------------------------------------------------------------------------------------
test('event identity includes the resource type: alert 123 and ticket 123 on one connection are different events', () => {
  const alert = normalizeAtera(scope, 'demo-atera-connection', { id: '123', revision: '1', agentId: 'demo-atera-agent-107', at, diskPercent: 90, severity: 'LOW' }, at);
  const ticketLike: NormalizedEvent = { ...alert, resourceType: 'ticket' };
  assert.notEqual(eventKey(alert), eventKey(ticketLike));
  assert.equal(eventKey(alert), eventKey({ ...alert, receivedAt: '2030-01-01T00:00:00.000Z' }), 'receivedAt is not part of identity');
});
test('concurrent duplicate deliveries produce one observation and one audit event', async () => {
  let calls = 0;
  const p = new ReferencePipeline({ provider: 'fixture', mode: 'fixture', async classify(e) { calls++; await new Promise(r => setTimeout(r, 10)); return new FixtureDecisionProvider().classify(e); } }, links);
  const results = await Promise.all(Array.from({ length: 5 }, () => p.ingest(actor, disk(), 'r1')));
  assert.equal(new Set(results.map(r => r.observation?.id)).size, 1); assert.equal(calls, 1);
  assert.equal((p.audit as MemoryAudit).list(scope).length, 1);
});
test('changed upstream revision is retained as a distinct event', async () => {
  const p = new ReferencePipeline(new FixtureDecisionProvider(), links);
  await p.ingest(actor, disk(), 'r1'); await p.ingest(actor, { ...disk(), revision: '2' }, 'r2');
  assert.equal(p.list(scope).length, 2);
});
test('same ID and revision with different content: canonical evidence kept, conflicting content stored separately and routed to urgent review', async () => {
  const p = new ReferencePipeline(new FixtureDecisionProvider(), links);
  const first = await p.ingest(actor, disk('MEDIUM'), 'r1');
  const second = await p.ingest(actor, disk('CRITICAL'), 'r2');
  assert.notEqual(second.eventKey, first.eventKey); assert.equal(second.conflictOfEventKey, first.eventKey);
  const o = second.observation!;
  assert.equal(o.severity, 'CRITICAL'); assert.equal(o.priority, 'URGENT'); assert.equal(o.route, 'HUMAN_REVIEW');
  assert.ok(o.reasonCodes.includes('REVISION_PAYLOAD_CONFLICT')); assert.equal(o.conflictOfEventKey, first.eventKey);
  const canonical = p.list(scope).find(x => x.eventKey === first.eventKey)!;
  assert.equal(canonical.severity, 'MEDIUM'); assert.equal(canonical.route, 'MONITOR'); assert.equal(canonical.event.sourceSeverity, 'MEDIUM', 'canonical evidence is never overwritten');
  assert.equal(p.list(scope).length, 2);
  const audit = (p.audit as MemoryAudit).list(scope);
  assert.equal(audit.filter(a => a.eventType === 'event.revision_conflict').length, 1);
  assert.ok(!JSON.stringify(audit).includes('"summary"'), 'conflict audit carries keys, not payload');
  // Exact redelivery of either variant is still a duplicate, not a new conflict.
  assert.equal((await p.ingest(actor, disk('CRITICAL'), 'r3')).observation?.id, o.id);
  assert.equal((await p.ingest(actor, disk('MEDIUM'), 'r4')).observation?.id, first.observation?.id);
  assert.equal(p.list(scope).length, 2);
});
test('concurrent delivery of conflicting content is detected before joining the in-flight canonical event', async () => {
  const p = new ReferencePipeline({ provider: 'fixture', mode: 'fixture', async classify(e) { await new Promise(r => setTimeout(r, 10)); return new FixtureDecisionProvider().classify(e); } }, links);
  const [a, b] = await Promise.all([p.ingest(actor, disk('MEDIUM'), 'r1'), p.ingest(actor, disk('CRITICAL'), 'r2')]);
  assert.notEqual(a.eventKey, b.eventKey);
  assert.equal(b.observation?.severity, 'CRITICAL'); assert.equal(b.observation?.route, 'HUMAN_REVIEW'); assert.equal(b.observation?.priority, 'URGENT');
  assert.equal(p.list(scope).length, 2);
  assert.equal((p.audit as MemoryAudit).list(scope).filter(x => x.eventType === 'event.revision_conflict').length, 1);
});

// --- Scope ------------------------------------------------------------------------------------------------------
test('actor cannot ingest another client event', async () => {
  const p = new ReferencePipeline(new FixtureDecisionProvider(), links);
  await assert.rejects(p.ingest(actor, { ...disk(), clientId: 'other-client' }, 'r'), /SCOPE_DENIED/);
  assert.equal(p.list(scope).length, 0); assert.equal(p.inbox(scope).length, 0);
});
test('cross-client and candidate links cannot resolve an identity', async () => {
  const p = new ReferencePipeline(new FixtureDecisionProvider(), links.map(l => ({ ...l, clientId: 'other-client' })));
  const o = (await p.ingest(actor, disk(), 'r')).observation!;
  assert.equal(o.entityId, null); assert.equal(o.route, 'HUMAN_REVIEW'); assert.ok(o.reasonCodes.includes('UNRESOLVED_DEVICE'));
  const p2 = new ReferencePipeline(new FixtureDecisionProvider(), links.map(l => ({ ...l, status: 'CANDIDATE' as const })));
  assert.equal((await p2.ingest(actor, disk(), 'r')).observation?.entityId, null);
});

// --- Conflicts, retries, dead letters ---------------------------------------------------------------------------
test('ambiguous confirmed links are quarantined to HUMAN_REVIEW with source severity, entity unresolved and audit written', async () => {
  const p = new ReferencePipeline(new FixtureDecisionProvider(), [...links, { ...links[1]!, entityId: 'other-device' }]);
  const result = await p.ingest(actor, critical(), 'r');
  assert.equal(result.status, 'PROCESSED');
  const o = result.observation!;
  assert.equal(o.severity, 'CRITICAL'); assert.equal(o.priority, 'URGENT'); assert.equal(o.route, 'HUMAN_REVIEW'); assert.equal(o.entityId, null);
  assert.ok(o.reasonCodes.includes('AMBIGUOUS_DEVICE_LINK')); assert.ok(o.reasonCodes.includes('SOURCE_URGENCY_FLOOR'));
  assert.equal(p.list(scope).length, 1);
  assert.equal((p.audit as MemoryAudit).list(scope).filter(a => a.eventType === 'observation.created').length, 1);
});
test('transient failure after storage is retried with preserved attempt state, then processed once', async () => {
  let failures = 2;
  const p = new ReferencePipeline(new FixtureDecisionProvider(), links, new MemoryAudit(), {
    maxAttempts: 3, commitHook: async () => { if (failures-- > 0) throw new AtlasError('DB_UNAVAILABLE', 'TRANSIENT'); }
  });
  const r1 = await p.ingest(actor, disk(), 'r'); assert.equal(r1.status, 'RETRY'); assert.equal(r1.attempts, 1); assert.equal(r1.safeErrorCode, 'DB_UNAVAILABLE');
  const r2 = await p.ingest(actor, disk(), 'r'); assert.equal(r2.status, 'RETRY'); assert.equal(r2.attempts, 2);
  const r3 = await p.ingest(actor, disk(), 'r'); assert.equal(r3.status, 'PROCESSED'); assert.equal(r3.attempts, 3);
  assert.equal(p.list(scope).length, 1);
  const audit = (p.audit as MemoryAudit).list(scope);
  assert.equal(audit.filter(a => a.eventType === 'event.retry_scheduled').length, 2);
  assert.equal(audit.filter(a => a.eventType === 'observation.created').length, 1);
});
test('a failing audit append publishes nothing: no applied run, no observation; the retry completes once without calling the provider again', async () => {
  let auditFailures = 1, calls = 0;
  const inner = new MemoryAudit();
  const flakyAudit = { append(scope: Parameters<MemoryAudit['append']>[0], actorId: string, eventType: string, correlationId: string, metadata: Record<string, string>) {
    if (eventType === 'observation.created' && auditFailures-- > 0) throw new AtlasError('AUDIT_UNAVAILABLE', 'TRANSIENT');
    inner.append(scope, actorId, eventType, correlationId, metadata);
  } };
  const p = new ReferencePipeline({ provider: 'openai', mode: 'advisory', async classify() { calls++; return { route: 'MONITOR', confidence: 0.99, provider: 'openai', reasonCodes: ['MODEL_ROUTE'], promptVersion: 'test' }; } }, links, flakyAudit);
  const r1 = await p.ingest(actor, disk(), 'r');
  assert.equal(r1.status, 'RETRY'); assert.equal(r1.safeErrorCode, 'AUDIT_UNAVAILABLE');
  assert.equal(p.list(scope).length, 0); assert.equal(p.decisionRuns(scope).filter(r => r.applied).length, 0, 'a failed audit write leaves no applied decision');
  const r2 = await p.ingest(actor, disk(), 'r');
  assert.equal(r2.status, 'PROCESSED'); assert.equal(calls, 1);
  assert.equal(p.list(scope).length, 1); assert.equal(p.decisionRuns(scope).filter(r => r.applied).length, 1);
  assert.equal(inner.list(scope).filter(a => a.eventType === 'observation.created').length, 1);
});
test('permanent failure or exhausted attempts become a visible dead letter, never a lost event', async () => {
  const p = new ReferencePipeline(new FixtureDecisionProvider(), links, new MemoryAudit(), {
    commitHook: async () => { throw new TypeError('bug in final transaction'); }
  });
  const r = await p.ingest(actor, critical(), 'r');
  assert.equal(r.status, 'DEAD_LETTER'); assert.equal(r.safeErrorCode, 'UNEXPECTED_ERROR'); assert.equal(r.observation, null);
  assert.equal(p.deadLetters(scope).length, 1);
  assert.ok((p.audit as MemoryAudit).list(scope).some(a => a.eventType === 'event.dead_lettered' && a.metadata.safeErrorCode === 'UNEXPECTED_ERROR'));
  const again = await p.ingest(actor, critical(), 'r'); assert.equal(again.status, 'DEAD_LETTER'); assert.equal(again.attempts, 1, 'dead letters are not reprocessed implicitly');
  const exhausted = new ReferencePipeline(new FixtureDecisionProvider(), links, new MemoryAudit(), {
    maxAttempts: 2, commitHook: async () => { throw new AtlasError('DB_UNAVAILABLE', 'TRANSIENT'); }
  });
  await exhausted.ingest(actor, disk(), 'r');
  assert.equal((await exhausted.ingest(actor, disk(), 'r')).status, 'DEAD_LETTER');
});

// --- Decision layer protections ----------------------------------------------------------------------------------
test('advisory provider refusal or failure becomes visible human review with a FAILED DecisionRun; the applied run is the fallback', async () => {
  const p = new ReferencePipeline({ provider: 'openai', mode: 'advisory', async classify() { throw new AtlasError('DECISION_REFUSED', 'PERMANENT'); } }, links);
  const o = (await p.ingest(actor, disk(), 'r')).observation!;
  assert.equal(o.route, 'HUMAN_REVIEW', 'docs/04: refusal, timeout, invalid output → HUMAN_REVIEW in advisory mode'); assert.equal(o.provider, 'rules');
  assert.ok(o.reasonCodes.includes('PROVIDER_UNAVAILABLE_OR_INVALID')); assert.ok(o.reasonCodes.includes('DECISION_REFUSED'));
  const runs = p.decisionRuns(scope);
  assert.ok(runs.some(r => r.status === 'FAILED' && r.safeErrorCode === 'DECISION_REFUSED' && !r.applied && r.provider === 'openai'));
  assert.equal(runs.filter(r => r.applied).length, 1); assert.equal(o.decisionRunId, runs.find(r => r.applied)?.id);
  assert.equal(runs.find(r => r.applied)?.route, 'HUMAN_REVIEW');
});
test('explicit rules mode routes on the deterministic baseline without any provider dependency', async () => {
  const p = new ReferencePipeline(new RulesDecisionProvider(), links);
  const o = (await p.ingest(actor, disk(), 'r')).observation!;
  assert.equal(o.route, 'MONITOR'); assert.equal(o.provider, 'rules'); assert.deepEqual(o.reasonCodes, ['RULES_BASELINE']);
});
test('retry of the final commit reuses the stored decision: provider called once, no applied run until commit, exactly one applied run after', async () => {
  let failures = 1, calls = 0;
  const p = new ReferencePipeline({ provider: 'openai', mode: 'advisory', async classify() { calls++; return { route: 'MONITOR', confidence: 0.99, provider: 'openai', reasonCodes: ['MODEL_ROUTE'], promptVersion: 'test' }; } }, links, new MemoryAudit(), {
    commitHook: async () => { if (failures-- > 0) throw new AtlasError('DB_UNAVAILABLE', 'TRANSIENT'); }
  });
  const r1 = await p.ingest(actor, disk(), 'r');
  assert.equal(r1.status, 'RETRY'); assert.equal(calls, 1);
  assert.equal(p.decisionRuns(scope).length, 1, 'decision persisted before commit');
  assert.equal(p.decisionRuns(scope).filter(r => r.applied).length, 0, 'a failed transaction leaves no applied decision');
  const r2 = await p.ingest(actor, disk(), 'r');
  assert.equal(r2.status, 'PROCESSED'); assert.equal(calls, 1, 'retry does not call the provider again');
  assert.equal(p.decisionRuns(scope).length, 1); assert.equal(p.decisionRuns(scope).filter(r => r.applied).length, 1);
  assert.equal(r2.observation?.decisionRunId, p.decisionRuns(scope)[0]?.id);
});
test('low confidence cannot quietly become monitor', async () => {
  const p = new ReferencePipeline(fixed({ confidence: 0.4 }), links);
  const o = (await p.ingest(actor, disk(), 'r')).observation!;
  assert.equal(o.route, 'HUMAN_REVIEW'); assert.ok(o.reasonCodes.includes('LOW_CONFIDENCE'));
});
test('critical source signal retains urgency even if classifier says monitor; every reason is kept', async () => {
  const p = new ReferencePipeline(fixed({ route: 'MONITOR', confidence: 0.99 }), links.map(l => ({ ...l, status: 'CANDIDATE' as const })));
  const o = (await p.ingest(actor, critical(), 'r')).observation!;
  assert.equal(o.severity, 'CRITICAL'); assert.equal(o.priority, 'URGENT'); assert.equal(o.route, 'HUMAN_REVIEW');
  assert.deepEqual(o.reasonCodes, ['MODEL_ROUTE', 'UNRESOLVED_DEVICE', 'SOURCE_URGENCY_FLOOR']);
});
test('shadow mode commits the rules baseline without waiting for the AI; the AI result lands later as a non-applied run and never changes the observation', async () => {
  let release!: (c: Classification) => void;
  const gate = new Promise<Classification>(resolve => { release = resolve; });
  const p = new ReferencePipeline({ provider: 'openai', mode: 'shadow', async classify() { return gate; } }, links);
  const result = await p.ingest(actor, critical(), 'r');
  assert.equal(result.status, 'PROCESSED', 'CRITICAL baseline is available while the shadow call is still pending');
  const o = result.observation!;
  assert.equal(o.route, 'HUMAN_REVIEW'); assert.equal(o.provider, 'rules'); assert.equal(o.priority, 'URGENT');
  assert.deepEqual(p.decisionRuns(scope).map(r => [r.provider, r.applied]), [['rules', true]]);
  release({ route: 'MONITOR', confidence: 0.99, provider: 'openai', reasonCodes: ['MODEL_ROUTE'], promptVersion: 'test', requestedModel: 'gpt-6-luna', responseModel: 'gpt-6-luna' });
  await p.drainShadow();
  const runs = p.decisionRuns(scope);
  assert.deepEqual(runs.map(r => [r.provider, r.applied, r.route]).sort(), [['openai', false, 'MONITOR'], ['rules', true, 'HUMAN_REVIEW']].sort());
  assert.equal(p.list(scope)[0]?.route, 'HUMAN_REVIEW', 'shadow result never rewrites the applied baseline');
  assert.equal(p.list(scope)[0]?.decisionRunId, runs.find(r => r.applied)?.id);
});
test('shadow provider failure is recorded as a non-applied FAILED run and does not touch the baseline', async () => {
  const p = new ReferencePipeline({ provider: 'openai', mode: 'shadow', async classify() { throw new AtlasError('DECISION_TIMEOUT', 'TRANSIENT'); } }, links);
  const o = (await p.ingest(actor, disk(), 'r')).observation!;
  await p.drainShadow();
  assert.equal(o.route, 'MONITOR'); assert.deepEqual(o.reasonCodes, ['RULES_BASELINE']);
  assert.ok(p.decisionRuns(scope).some(r => r.status === 'FAILED' && !r.applied && r.safeErrorCode === 'DECISION_TIMEOUT'));
});
test('rules provider is deterministic from source facts', async () => {
  const rules = new RulesDecisionProvider();
  assert.equal((await rules.classify(disk())).route, 'MONITOR');
  assert.equal((await rules.classify(critical())).route, 'HUMAN_REVIEW');
});

// --- Audit shape -------------------------------------------------------------------------------------------------
test('client audit records are built from an allowlist: no event payload, no unknown metadata', async () => {
  const { audit, pipeline } = await runDemo();
  for (const record of audit.list(scope)) {
    assert.deepEqual(Object.keys(record).sort(), [...auditKeys].sort());
    assert.ok(Object.keys(record.metadata).every(k => auditMetadataAllowlist.includes(k)));
  }
  assert.ok(!JSON.stringify(audit.list(scope)).includes('credential theft'));
  audit.append({ ...scope, summary: 'leak', facts: { signal: 'leak' } } as never, 'a', 'x', 'c', { summary: 'leak', tool: 'ok' });
  const last = audit.list(scope).at(-1)!;
  assert.ok(!('summary' in last)); assert.deepEqual(last.metadata, { tool: 'ok' });
  assert.equal(pipeline.list(scope).length, 2);
});
test('returned observations and audit records cannot mutate internal state', async () => {
  const p = new ReferencePipeline(new FixtureDecisionProvider(), links);
  const first = (await p.ingest(actor, disk(), 'r')).observation!; first.route = 'INVESTIGATE'; first.reasonCodes.push('x');
  const audit = (p.audit as MemoryAudit).list(scope); audit[0]!.metadata.route = 'changed';
  assert.equal(p.list(scope)[0]?.route, 'MONITOR'); assert.deepEqual(p.list(scope)[0]?.reasonCodes, ['SYNTHETIC_FIXTURE_ONLY']);
  assert.equal((p.audit as MemoryAudit).list(scope)[0]?.metadata.route, 'MONITOR');
});

// --- Tool gateway ------------------------------------------------------------------------------------------------
test('unknown or write tool is denied before execution and audited in the client log', async () => {
  const { context, audit, securityAudit } = await runDemo(); let reads = 0;
  await assert.rejects(executeReadTool(actor, scope, 'atera.ticket.create', async () => { reads++; return context; }, { audit, securityAudit }), /TOOL_DENIED/);
  assert.equal(reads, 0); assert.equal(audit.list(scope).at(-1)?.eventType, 'tool.denied');
});
test('scope denial is recorded in the workspace security audit, never in the target client audit, before any read', async () => {
  const { context, audit, securityAudit } = await runDemo(); let reads = 0;
  const other = { workspaceId: scope.workspaceId, clientId: 'other-client' };
  await assert.rejects(executeReadTool(actor, other, 'atlas.client.get_context', async () => { reads++; return context; }, { audit, securityAudit }), /SCOPE_DENIED/);
  assert.equal(reads, 0);
  assert.equal(audit.list(other).length, 0);
  const denial = securityAudit.list(scope.workspaceId).at(-1)!;
  assert.equal(denial.eventType, 'tool.scope_denied'); assert.equal(denial.requestedClientId, 'other-client'); assert.equal(denial.reasonCode, 'SCOPE_DENIED');
});
test('tool context with wrong scope or contract is rejected and audited', async () => {
  const { context, audit, securityAudit } = await runDemo();
  await assert.rejects(executeReadTool(actor, scope, 'atlas.client.get_context', async () => ({ ...context, clientId: 'wrong' }), { audit, securityAudit }), /CONTEXT_SCOPE_MISMATCH/);
  assert.equal(audit.list(scope).at(-1)?.eventType, 'tool.failed'); assert.equal(audit.list(scope).at(-1)?.metadata.safeErrorCode, 'CONTEXT_SCOPE_MISMATCH');
  await assert.rejects(executeReadTool(actor, scope, 'atlas.client.get_context', async () => ({ ...context, contractVersion: 'v0' } as never), { audit, securityAudit }), /CONTEXT_CONTRACT_MISMATCH/);
});
test('resource tools return an explicit resource view, never undefined, for fixture and DB-shaped contexts', async () => {
  const { context, audit, securityAudit } = await runDemo();
  const tickets = await executeReadTool(actor, scope, 'atera.ticket.list', async () => context, { audit, securityAudit }) as { status: string; items: unknown[] };
  assert.equal(tickets.status, 'FIXTURE'); assert.equal(tickets.items.length, 1);
  const dbShaped = { ...context, mode: 'db' as const, resources: [] };
  const missing = await executeReadTool(actor, scope, 'huntress.incident.list', async () => dbShaped, { audit, securityAudit }) as { status: string; items: unknown; safeErrorCode: string };
  assert.equal(missing.status, 'MISSING'); assert.equal(missing.items, null); assert.equal(missing.safeErrorCode, 'RESOURCE_NOT_CONFIGURED');
});

// --- Decisions contract --------------------------------------------------------------------------------------------
function body(choice: string = 'MONITOR', confidence = 0.99, model = 'gpt-6-luna') {
  return { model, answers: [{ name: 'route', type: 'choice', choice, confidence,
    probabilities: [{ value: 'MONITOR', probability: 0.99 }, { value: 'INVESTIGATE', probability: 0.005 }, { value: 'HUMAN_REVIEW', probability: 0.005 }] }] };
}
test('decision contract parser accepts allowed route and rejects refusals, extra answers, invalid probabilities and unexpected models', () => {
  assert.equal(parseRouteResponse(body()).route, 'MONITOR');
  assert.equal(parseRouteResponse(body()).responseModel, 'gpt-6-luna');
  assert.throws(() => parseRouteResponse(body('DELETE_USER')), /INVALID/);
  assert.throws(() => parseRouteResponse(body('MONITOR', NaN)), /INVALID/);
  assert.throws(() => parseRouteResponse({ model: 'gpt-6-luna', answers: [{ name: 'route', type: 'refusal' }] }), /REFUSED/);
  const b = body(); b.answers.push(b.answers[0]!); assert.throws(() => parseRouteResponse(b), /INVALID/);
  assert.throws(() => parseRouteResponse(body('MONITOR', 0.99, 'gpt-6-luna-2026-10-06')), /MODEL_MISMATCH/);
  assert.equal(parseRouteResponse(body('MONITOR', 0.99, 'gpt-6-luna-2026-10-06'), ['gpt-6-luna', 'gpt-6-luna-2026-10-06']).responseModel, 'gpt-6-luna-2026-10-06');
});
test('model mismatch is a distinct FAILED DecisionRun code, not a generic failure', async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify(body('MONITOR', 0.99, 'some-other-model')), { status: 200 });
  const p = new ReferencePipeline(new OpenAIDecisionProvider('mock-not-a-key', defaultDecisionConfig, fetcher, 'advisory'), links);
  const o = (await p.ingest(actor, disk(), 'r')).observation!;
  assert.ok(o.reasonCodes.includes('MODEL_MISMATCH')); assert.equal(o.route, 'HUMAN_REVIEW');
  const failed = p.decisionRuns(scope).find(r => r.status === 'FAILED')!;
  assert.equal(failed.safeErrorCode, 'MODEL_MISMATCH'); assert.equal(failed.provider, 'openai'); assert.equal(failed.applied, false);
  assert.equal(failed.requestedModel, 'gpt-6-luna'); assert.equal(failed.responseModel, 'some-other-model', 'diagnostics survive the failure');
  const timeout: typeof fetch = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
  const p2 = new ReferencePipeline(new OpenAIDecisionProvider('mock-not-a-key', defaultDecisionConfig, timeout, 'advisory'), links);
  await p2.ingest(actor, disk(), 'r');
  const failed2 = p2.decisionRuns(scope).find(r => r.status === 'FAILED')!;
  assert.equal(failed2.safeErrorCode, 'DECISION_TIMEOUT'); assert.equal(failed2.requestedModel, 'gpt-6-luna'); assert.equal(failed2.responseModel, null);
});
test('Decisions input omits client, person and external identifiers', () => {
  const input = decisionInput(disk()); assert.ok(!input.includes(scope.clientId));
  assert.ok(!input.includes('demo-atera-agent-107')); assert.ok(!input.includes('example.invalid')); assert.ok(!input.includes('demo-atera-connection'));
});
test('OpenAI adapter sends configured model to the verified endpoint with a deadline; mocked transport only', async () => {
  let called = false;
  const fetcher: typeof fetch = async (url, options) => {
    called = true; assert.equal(url, 'https://api.openai.com/v1/decisions');
    assert.equal(options?.method, 'POST'); assert.ok(options?.signal);
    const req = JSON.parse(String(options?.body)); assert.equal(req.model, 'gpt-6-luna'); assert.equal(req.questions[0].name, 'route');
    return new Response(JSON.stringify(body()), { status: 200 });
  };
  const result = await new OpenAIDecisionProvider('mock-not-a-key', defaultDecisionConfig, fetcher).classify(disk());
  assert.equal(result.route, 'MONITOR'); assert.equal(result.requestedModel, 'gpt-6-luna'); assert.equal(result.responseModel, 'gpt-6-luna'); assert.ok(called);
  const flaky: typeof fetch = async () => new Response('', { status: 503 });
  await assert.rejects(new OpenAIDecisionProvider('mock-not-a-key', defaultDecisionConfig, flaky).classify(disk()), (e: unknown) => e instanceof AtlasError && e.kind === 'TRANSIENT');
});

// --- Normalizers ---------------------------------------------------------------------------------------------------
test('invalid source payload is rejected and source severity is taken from the source, not from a threshold', () => {
  assert.throws(() => normalizeAtera(scope, 'c', { id: '1', revision: '1', agentId: 'a', at, diskPercent: 101, severity: 'LOW' }, at), /BAD_DISK_PERCENT/);
  assert.throws(() => normalizeAtera(scope, 'c', { id: '1', revision: '1', agentId: 'a', at, diskPercent: 50, severity: 'SEVERE' as never }, at), /BAD_EVENT/);
  const e = normalizeAtera(scope, 'c', { id: '1', revision: '1', agentId: 'a', at, diskPercent: 99, severity: 'LOW' }, at);
  assert.equal(e.sourceSeverity, 'LOW'); assert.equal(e.resourceType, 'alert'); assert.deepEqual(e.externalDevice, { resourceType: 'agent', externalId: 'a' });
});
