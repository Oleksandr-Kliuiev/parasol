// Normalized Stage 1 contracts (v1.1). Plain TypeScript: no enums, so the files run under --experimental-strip-types.
export type System = 'atera' | 'huntress' | 'microsoft365' | 'poweroffice';
export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Route = 'MONITOR' | 'INVESTIGATE' | 'HUMAN_REVIEW';
/** Deterministic urgency derived from source severity. Independent of the advisory route. */
export type Priority = 'NORMAL' | 'URGENT';
export type EventKind = 'DISK_CAPACITY' | 'SECURITY_INCIDENT';
/** Observation category. Stage 1 semantics: DISK_CAPACITY -> OPERATIONS, SECURITY_INCIDENT -> SECURITY. */
export type Domain = 'OPERATIONS' | 'SECURITY';
export type EntityKind = 'PERSON' | 'DEVICE';
/** Vendor-neutral external resource types. Adapters map vendor objects onto these names; identity always includes the type. */
export type ResourceType = 'customer' | 'organization' | 'agent' | 'contact' | 'alert' | 'ticket' | 'incident';
export type DecisionMode = 'fixture' | 'rules' | 'shadow' | 'advisory';
/** QUARANTINED: a confirmation that conflicted with an existing confirmed link; kept for review, never resolved. */
export type LinkStatus = 'CONFIRMED' | 'CANDIDATE' | 'REJECTED' | 'QUARANTINED';

// ---------------------------------------------------------------------------------------------------------------------
// Errors. The kind decides what the durable pipeline does after an event is stored:
//   SCOPE / VALIDATION  -> rejected before storage (caller error, audited where an actor is involved)
//   CONFLICT            -> stored; observation with visible HUMAN_REVIEW, source severity retained
//   TRANSIENT           -> stored; bounded retry with preserved attempt state
//   PERMANENT           -> stored; dead-letter with visible reason code
// ---------------------------------------------------------------------------------------------------------------------
export type ErrorKind = 'SCOPE' | 'VALIDATION' | 'CONFLICT' | 'TRANSIENT' | 'PERMANENT';
export class AtlasError extends Error {
  readonly code: string;
  readonly kind: ErrorKind;
  /** Safe, bounded diagnostic fields (for example requestedModel/responseModel). Never a body, header, key or payload. */
  readonly details: Record<string, string>;
  constructor(code: string, kind: ErrorKind, details: Record<string, string> = {}) {
    super(code);
    this.name = 'AtlasError';
    this.code = code;
    this.kind = kind;
    this.details = Object.fromEntries(Object.entries(details).map(([k, v]) => [k, String(v).slice(0, 200)]));
  }
  /** Same error with extra safe details; existing details win over the additions. */
  withDetails(extra: Record<string, string>): AtlasError { return new AtlasError(this.code, this.kind, { ...extra, ...this.details }); }
}
/** Safe error code for logs, audit and DecisionRun. Unknown errors are never serialized; they become UNEXPECTED_ERROR. */
export function safeErrorCode(error: unknown): string {
  return error instanceof AtlasError ? error.code : 'UNEXPECTED_ERROR';
}
/** Unknown errors are treated as PERMANENT: visible dead-letter, no endless retry of a bug. */
export function errorKind(error: unknown): ErrorKind {
  return error instanceof AtlasError ? error.kind : 'PERMANENT';
}
export function errorDetails(error: unknown): Record<string, string> {
  return error instanceof AtlasError ? { ...error.details } : {};
}

// ---------------------------------------------------------------------------------------------------------------------
// Scope and actor. Permissions are per client (memberships); workspace permissions cover MSP-wide reads such as the
// security audit. The model, request body or AI output can never supply any of these.
// ---------------------------------------------------------------------------------------------------------------------
export interface Scope { workspaceId: string; clientId: string }
export interface Membership { clientId: string; permissions: string[] }
export interface Actor { id: string; workspaceId: string; memberships: Membership[]; workspacePermissions: string[] }

export function allowedClientIds(actor: Actor): string[] { return actor.memberships.map(m => m.clientId); }
export function hasClientPermission(actor: Actor, clientId: string, permission: string): boolean {
  return actor.memberships.some(m => m.clientId === clientId && m.permissions.includes(permission));
}
export function assertScope(actor: Actor, scope: Scope): void {
  if (actor.workspaceId !== scope.workspaceId || !actor.memberships.some(m => m.clientId === scope.clientId)) {
    throw new AtlasError('SCOPE_DENIED', 'SCOPE');
  }
}
export function assertPermission(actor: Actor, scope: Scope, permission: string): void {
  assertScope(actor, scope);
  if (!hasClientPermission(actor, scope.clientId, permission)) throw new AtlasError('PERMISSION_DENIED', 'SCOPE');
}
export function assertWorkspacePermission(actor: Actor, workspaceId: string, permission: string): void {
  if (actor.workspaceId !== workspaceId || !actor.workspacePermissions.includes(permission)) {
    throw new AtlasError('PERMISSION_DENIED', 'SCOPE');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Client graph
// ---------------------------------------------------------------------------------------------------------------------
export interface Person extends Scope { id: string; displayName: string; email: string | null }
export interface Device extends Scope { id: string; hostname: string; personId: string | null }
export interface ExternalRef { resourceType: ResourceType; externalId: string }
export interface ExternalLink extends Scope {
  connectionId: string; system: System; resourceType: ResourceType; externalId: string;
  entityId: string; entityKind: EntityKind; status: LinkStatus;
}

// ---------------------------------------------------------------------------------------------------------------------
// Events and observations
// ---------------------------------------------------------------------------------------------------------------------
export interface NormalizedEvent extends Scope {
  source: System; connectionId: string;
  /** Type of the source object the event is (alert, incident, ticket). Part of event identity. */
  resourceType: ResourceType; externalEventId: string; revision: string;
  /** The device-like source object the event refers to, when the source states one. */
  externalDevice: ExternalRef | null;
  occurredAt: string; receivedAt: string;
  kind: EventKind;
  /** Severity as reported by the source after a documented mapping. Never derived from an Atlas threshold. */
  sourceSeverity: Severity;
  summary: string;
  facts: { diskPercent?: number; signal?: string };
}
export const severityRank: Record<Severity, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
export const severities: readonly Severity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const routes: readonly Route[] = ['MONITOR', 'INVESTIGATE', 'HUMAN_REVIEW'];
export function domainOf(kind: EventKind): Domain { return kind === 'SECURITY_INCIDENT' ? 'SECURITY' : 'OPERATIONS'; }
/** Deterministic urgency floor: HIGH/CRITICAL source severity is URGENT whatever any classifier says. */
export function priorityOf(severity: Severity): Priority { return severityRank[severity] >= severityRank.HIGH ? 'URGENT' : 'NORMAL'; }

export type Provider = 'fixture' | 'openai' | 'rules';
export interface Classification {
  route: Route; confidence: number; provider: Provider; promptVersion: string;
  reasonCodes: string[];
  requestedModel?: string; responseModel?: string;
  /** Input tokens the provider reported for the call, when it reported them (task 1.7 telemetry). */
  inputTokens?: number;
}
/** One provider call. In shadow mode the AI run is stored with applied=false next to the applied baseline run. */
export interface DecisionRunRecord extends Scope {
  id: string; eventKey: string; provider: Provider; mode: DecisionMode; applied: boolean;
  status: 'OK' | 'FAILED'; route: Route | null; confidence: number | null; promptVersion: string;
  requestedModel: string | null; responseModel: string | null; safeErrorCode: string | null;
  latencyMs: number; createdAt: string;
}
export interface Observation extends Scope {
  id: string; eventKey: string; event: NormalizedEvent;
  /** Canonical entity resolved through a CONFIRMED link of the matching resource type and entity kind; null when unresolved. */
  entityId: string | null;
  domain: Domain; severity: Severity; priority: Priority;
  route: Route; confidence: number; provider: Provider; promptVersion: string;
  /** Every rule that influenced the result, in order. Nothing is overwritten. */
  reasonCodes: string[];
  decisionRunId: string | null;
  /** Set when this observation carries a conflicting redelivery (same source ID/revision, different content) of another event. */
  conflictOfEventKey: string | null;
  status: 'OPEN';
  createdAt: string;
}
/** Bounded projection used in context and tool results. The full event is fetched by source ID through a read tool. */
/** Observation lifecycle (task 1.8): OPEN → ACKNOWLEDGED → RESOLVED | SUPPRESSED; reopen goes back to OPEN. */
export type ObservationStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'SUPPRESSED';
export const observationStatuses: readonly ObservationStatus[] = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED'];
/** Still needing attention: the context lists these and counts them. */
export const activeObservationStatuses: readonly ObservationStatus[] = ['OPEN', 'ACKNOWLEDGED'];
/**
 * Source link (source, connectionId, resourceType, externalEventId, revision, eventKey) and explanation (entityId,
 * decisionRunId, priority, reasonCodes) are kept through every lifecycle change; `supersededById` points at the newer
 * observation of the same source object. Operator identities stay in the audit, not in the summary.
 */
export interface ObservationSummary extends Scope {
  id: string; eventKey: string; source: System; connectionId: string; resourceType: ResourceType; externalEventId: string; revision: string;
  entityId: string | null; decisionRunId: string | null; kind: EventKind; domain: Domain; severity: Severity; priority: Priority;
  route: Route; confidence: number; provider: Provider; reasonCodes: string[]; conflictOfEventKey: string | null;
  status: ObservationStatus; acknowledgedAt: string | null; resolvedAt: string | null; supersededById: string | null;
  summary: string; occurredAt: string; createdAt: string; updatedAt: string;
}
export function toObservationSummary(o: Observation): ObservationSummary {
  return { workspaceId: o.workspaceId, clientId: o.clientId, id: o.id, eventKey: o.eventKey, source: o.event.source, connectionId: o.event.connectionId,
    resourceType: o.event.resourceType, externalEventId: o.event.externalEventId, revision: o.event.revision,
    entityId: o.entityId, decisionRunId: o.decisionRunId, kind: o.event.kind, domain: o.domain, severity: o.severity, priority: o.priority, route: o.route,
    confidence: o.confidence, provider: o.provider, reasonCodes: [...o.reasonCodes], conflictOfEventKey: o.conflictOfEventKey,
    status: o.status, acknowledgedAt: null, resolvedAt: null, supersededById: null,
    summary: o.event.summary, occurredAt: o.event.occurredAt, createdAt: o.createdAt, updatedAt: o.createdAt };
}

export type InboxStatus = 'RECEIVED' | 'PROCESSED' | 'RETRY' | 'DEAD_LETTER';
export interface InboxEntry extends Scope {
  eventKey: string; conflictOfEventKey: string | null; status: InboxStatus; attempts: number; lastErrorCode: string | null; receivedAt: string; updatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Audit. Client-scoped audit never contains event payloads; the record shape is an allowlist, not a spread.
// Security audit is workspace-scoped: denials must be visible to MSP administrators and must not land in a client's log.
// ---------------------------------------------------------------------------------------------------------------------
export interface AuditRecord extends Scope {
  id: string; actorId: string; eventType: string; correlationId: string; recordedAt: string; metadata: Record<string, string>;
}
export interface AuditSink {
  append(scope: Scope, actorId: string, eventType: string, correlationId: string, metadata: Record<string, string>): void;
}
export interface SecurityAuditRecord {
  id: string; workspaceId: string; actorId: string; eventType: string; outcome: 'DENIED';
  /**
   * Client ID as requested by the caller, stored as escaped bounded text (packages/audit/sanitize.ts). Plain text, never a
   * foreign key: the client may not exist, may be out of scope or may not even be a well-formed identifier.
   */
  requestedClientId: string | null;
  reasonCode: string; correlationId: string; recordedAt: string; metadata: Record<string, string>;
}
export interface SecurityAuditSink {
  append(record: Omit<SecurityAuditRecord, 'id' | 'recordedAt'>): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// ClientContextV1: the single output contract for fixtures, the DB-backed query and tool results.
// A resource that is not available has an explicit status; it is never reported as an empty list.
// ---------------------------------------------------------------------------------------------------------------------
export type ResourceStatus = 'OK' | 'STALE' | 'ERROR' | 'MISSING' | 'FIXTURE';
/**
 * Compact projection of one live source record (task 1.5): source references and documented status fields only. The
 * title is the source's one-line subject, bounded; contact names, e-mail addresses and phone numbers are never copied.
 * The full record is read by source ID through a read tool.
 */
export interface SnapshotItem {
  source: System; resourceType: ResourceType; externalId: string;
  title: string;
  /** Status as the source documents it (for example `sent`, `Open`). */
  status: string;
  /** Source severity after the documented mapping (connectors/CONTRACTS.md); null when the source has none (tickets). */
  severity: Severity | null;
  /** Source priority as documented (tickets); null otherwise. */
  priority: string | null;
  /** The device-like source object the record refers to, when the source states one. */
  device: ExternalRef | null;
  occurredAt: string | null; updatedAt: string | null;
}
export interface ResourceView<T = unknown> {
  source: System; resourceType: ResourceType; connectionId: string | null; status: ResourceStatus;
  asOf: string | null; lastSuccessAt: string | null; safeErrorCode: string | null;
  /** null unless status is OK, STALE or FIXTURE. An empty array means "successfully read, nothing there". */
  items: T[] | null; truncated: boolean;
}
export interface ObservationPage {
  items: ObservationSummary[];
  /** Counts over the whole selected set (the context: every active observation), not over the returned page. */
  counts: Record<Severity, number>;
  total: number; truncated: boolean;
  /** Opaque keyset cursor of the next page (GET /clients/:id/observations), null on the last page. */
  nextCursor: string | null;
}
export interface ClientContextV1 extends Scope {
  contractVersion: 'ClientContextV1';
  mode: 'fixture' | 'db';
  clientName: string;
  people: Person[]; devices: Device[]; links: ExternalLink[];
  observations: ObservationPage;
  resources: ResourceView[];
  generatedAt: string;
  completeness: 'COMPLETE_FIXTURE' | 'PARTIAL' | 'COMPLETE';
}
export function emptyCounts(): Record<Severity, number> { return { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }; }
export function findResource(ctx: ClientContextV1, source: System, resourceType: ResourceType): ResourceView {
  return ctx.resources.find(r => r.source === source && r.resourceType === resourceType) ??
    { source, resourceType, connectionId: null, status: 'MISSING', asOf: null, lastSuccessAt: null, safeErrorCode: 'RESOURCE_NOT_CONFIGURED', items: null, truncated: false };
}
