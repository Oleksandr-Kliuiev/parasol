import { hasClientPermission } from '../core/contracts.ts';
import type { Actor, AuditSink, SecurityAuditSink } from '../core/contracts.ts';
import { SCOPE_ID_PATTERN } from '../graph/scope-context.ts';
import { ASK_AUDIT, ASK_LIMITS, askFailure } from './contracts.ts';
import { fixtureCredential, fixtureTokenMatches } from './credential.ts';
import type { AskCredential } from './credential.ts';
import { askAuditRecord } from './audit.ts';
import type { AskAuditOutcome } from './audit.ts';
import {
  CONTEXT_RESOURCE_TYPES, EVENT_KINDS, M365_RESOURCE_TYPES, SEVERITIES, SourceMeter, activePage, flag, graphEntities, graphLinks, identifier, inScope,
  invalid, list, nullableText, nullableTime, object, oneOf, scopeId, sourceClass, text, time, uniqueResources
} from './source.ts';
import type { AskSourceRead, FocusRead, GraphEntity, Scope, SourceResource } from './source.ts';
import type { AskAdmission, AskIdentity, AskPort, AskRun } from './service.ts';

/**
 * Synthetic fixture Ask port (03 "Fixture path"): the accepted equality-token rule and the demo actor's memberships stand
 * in for current authority — labelled synthetic; DB revocation/fence claims are proven only on real PostgreSQL. Same DTO,
 * compiler and caps; in-memory audit semantics (MemoryAudit/MemorySecurityAudit of the demo). The demo ClientContextV1 is
 * validated as a whole original read before projection; fixture Huntress evidence lookup stays unsupported — its resource
 * card is the existing stored FIXTURE state, not a performed lookup.
 */
export interface FixtureAskDemo { readonly context: unknown; readonly audit: AuditSink; readonly securityAudit: SecurityAuditSink }
export interface FixtureAskOptions {
  readonly demo: () => Promise<FixtureAskDemo>;
  readonly demoToken: () => string | undefined;
  readonly actor: Actor;
  readonly scope: Scope;
}

function fixtureItem(raw: unknown, resource: SourceResource, scope: Scope): void {
  const row = object(raw);
  if ((resource.source === 'atera' && resource.resourceType === 'alert') || (resource.source === 'huntress' && resource.resourceType === 'incident')) {
    inScope(row, scope);
    if (row.source !== resource.source || row.connectionId !== resource.connectionId || row.resourceType !== resource.resourceType) invalid();
    identifier(row.externalEventId); text(row.revision); oneOf(row.kind, EVENT_KINDS); text(row.summary);
    oneOf(row.sourceSeverity, SEVERITIES); time(row.occurredAt);
  } else if (resource.source === 'atera' && resource.resourceType === 'ticket') {
    identifier(row.id); text(row.title); text(row.status);
  } else invalid();
}

/** Whole fixture context → validated source read (no repair). Excluded known systems are skipped; unknown ones are invalid. */
export function fixtureSource(context: unknown, scope: Scope, focusId: string | null): AskSourceRead {
  new SourceMeter().add(context);
  const root = object(context);
  inScope(root, scope);
  if (root.contractVersion !== 'ClientContextV1' || root.mode !== 'fixture') invalid();
  const pageRoot = object(root.observations);
  if (flag(pageRoot.truncated) || pageRoot.nextCursor !== null) invalid();
  const rows = list(pageRoot.items, ASK_LIMITS.observationPage).filter(row => sourceClass(object(row).source) === 'ASK');
  const page = activePage(rows, scope);
  let focus: FocusRead = { state: 'NONE' };
  if (focusId !== null) {
    const found = page.find(o => o.observationId === focusId);
    focus = found ? { state: 'FOUND', observation: found, onPage: true } : { state: 'MISSING' };
  }
  const entity = (raw: unknown, kind: 'PERSON' | 'DEVICE'): GraphEntity => {
    const row = object(raw); inScope(row, scope);
    return { id: identifier(row.id), kind, label: text(kind === 'PERSON' ? row.displayName : row.hostname) };
  };
  const entities = graphEntities(list(root.people, ASK_LIMITS.graphRows).map(p => entity(p, 'PERSON')),
    list(root.devices, ASK_LIMITS.graphRows).map(d => entity(d, 'DEVICE')));
  // Context links are CONFIRMED and never Microsoft 365 (context-mapper.ts second guard); graphLinks validates the rest.
  const links = graphLinks(list(root.links, ASK_LIMITS.graphRows).filter(raw => {
    const row = object(raw); inScope(row, scope);
    return row.system !== 'microsoft365' && !M365_RESOURCE_TYPES.includes(row.resourceType as string);
  }), entities);
  const resources: SourceResource[] = [];
  for (const raw of list(root.resources, ASK_LIMITS.resources)) {
    const row = object(raw);
    if (sourceClass(row.source) === 'EXCLUDED') continue;
    const resource: SourceResource = { source: oneOf(row.source, ['atera', 'huntress'] as const), resourceType: oneOf(row.resourceType, CONTEXT_RESOURCE_TYPES),
      connectionId: row.connectionId === null ? null : scopeId(row.connectionId), status: oneOf(row.status, ['FIXTURE'] as const),
      asOf: nullableTime(row.asOf), lastSuccessAt: nullableTime(row.lastSuccessAt), truncated: flag(row.truncated) };
    nullableText(row.safeErrorCode);
    for (const item of list(row.items, ASK_LIMITS.resourceItems)) fixtureItem(item, resource, scope);
    resources.push(resource);
  }
  return Object.freeze({ mode: 'fixture' as const, page, pageTruncated: false, focus, entities, links, resources: uniqueResources(resources) });
}

export function fixtureAskPort(options: FixtureAskOptions): AskPort {
  const { actor, scope } = options;
  const identity: AskIdentity = Object.freeze({ workspaceId: actor.workspaceId, actorId: actor.id });
  const current = (credential: AskCredential) => fixtureTokenMatches(credential, options.demoToken());
  /** Synthetic membership rule of the accepted fixture API; a denial is one workspace security record, then 403. */
  async function authorize(run: AskRun, credential: AskCredential, clientId: string): Promise<void> {
    if (!current(credential)) askFailure('ASK_AUTHENTICATION_FAILED');
    const member = actor.workspaceId === scope.workspaceId && SCOPE_ID_PATTERN.test(clientId) && actor.memberships.some(m => m.clientId === clientId);
    if (member && hasClientPermission(actor, clientId, ASK_AUDIT.permission)) return;
    run.check();
    // rc3 (R2b): the demo may be asynchronous; terminal/original deadline is checked AFTER its await, before the append.
    const demo = await options.demo();
    run.check();
    demo.securityAudit.append({ workspaceId: actor.workspaceId, actorId: actor.id, eventType: ASK_AUDIT.denied, outcome: 'DENIED',
      requestedClientId: clientId, reasonCode: member ? 'PERMISSION_DENIED' : 'SCOPE_DENIED', correlationId: run.correlationId, metadata: {} });
    askFailure('ASK_SCOPE_DENIED');
  }
  return Object.freeze({
    sourceMode: 'fixture' as const,
    credential: fixtureCredential,
    async authenticate(_run: AskRun, credential: AskCredential): Promise<AskIdentity | null> { return current(credential) ? identity : null; },
    async admit(run: AskRun, _identity: AskIdentity, credential: AskCredential, clientId: string, focusId: string | null): Promise<AskAdmission> {
      await authorize(run, credential, clientId);
      run.check();
      if (!run.owner.charge()) askFailure('ASK_BUSY');
      if (clientId !== scope.clientId) askFailure('ASK_CONTEXT_UNAVAILABLE');
      const demo = await options.demo();
      run.check();
      return Object.freeze({ scope, epoch: 'fixture', source: fixtureSource(demo.context, scope, focusId) });
    },
    async publish(run: AskRun, _identity: AskIdentity, credential: AskCredential, admission: AskAdmission, outcome: AskAuditOutcome): Promise<void> {
      await authorize(run, credential, admission.scope.clientId);
      run.check();
      const record = askAuditRecord(outcome);
      const demo = await options.demo();
      run.check();
      demo.audit.append(admission.scope, actor.id, record.eventType, run.correlationId, record.metadata);
    }
  });
}
