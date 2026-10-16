// Browser projection of the accepted Stage 1 read contracts (docs/stage5/02_CONTRACTS.md). DOM-free and import-free, so
// Node parity tests (tests/operator-contracts.test.ts) compare these copies with packages/core and packages/auth.
// Versioned with the console: a change to an accepted contract must update this file and its parity test together.

/** packages/auth/token.ts BEARER_TOKEN_PATTERN: RFC 6750 b64token, 20..256 characters. Input is never trimmed or normalized. */
export const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9\-._~+/]{20,256}={0,2}$/;
/** packages/graph/scope-context.ts SCOPE_ID_PATTERN: workspace, client and connection identifiers. */
export const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** packages/graph/mapping.ts EXTERNAL_ID_PATTERN: source identifiers. */
export const EXTERNAL_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;
/** apps/api/src/http-boundary.ts observation cursor format (opaque). */
export const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,400}$/;
/** apps/api/src/http-boundary.ts REQUEST_ID_PATTERN: the optional requestId of POST /tools/execute. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;
/** Optional X-Atlas-Correlation-Id / X-Atlas-Tool-Execution-Id shown as diagnostic text only when they are this opaque form. */
export const DIAGNOSTIC_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export const SYSTEMS = ['atera', 'huntress', 'microsoft365', 'poweroffice'] as const;
/** Systems ClientContextV1 can carry: Microsoft 365 rows are excluded from the Stage 1 projection. */
export const CONTEXT_SYSTEMS = ['atera', 'huntress', 'poweroffice'] as const;
/** ResourceType without the internal m365_* types, which ClientContextV1 never exposes. */
export const CONTEXT_RESOURCE_TYPES = ['customer', 'organization', 'agent', 'contact', 'alert', 'ticket', 'incident'] as const;
export const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const ROUTES = ['MONITOR', 'INVESTIGATE', 'HUMAN_REVIEW'] as const;
export const PRIORITIES = ['NORMAL', 'URGENT'] as const;
export const EVENT_KINDS = ['DISK_CAPACITY', 'SECURITY_INCIDENT'] as const;
export const DOMAINS = ['OPERATIONS', 'SECURITY'] as const;
export const ENTITY_KINDS = ['PERSON', 'DEVICE'] as const;
export const PROVIDERS = ['fixture', 'openai', 'rules'] as const;
export const OBSERVATION_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED'] as const;
export const ACTIVE_OBSERVATION_STATUSES = ['OPEN', 'ACKNOWLEDGED'] as const;
export const RESOURCE_STATUSES = ['OK', 'STALE', 'ERROR', 'MISSING', 'FIXTURE'] as const;
export const CONTEXT_MODES = ['fixture', 'db'] as const;
export const COMPLETENESS = ['COMPLETE_FIXTURE', 'PARTIAL', 'COMPLETE'] as const;

export type System = typeof SYSTEMS[number];
export type ContextSystem = typeof CONTEXT_SYSTEMS[number];
export type ResourceType = typeof CONTEXT_RESOURCE_TYPES[number];
export type Severity = typeof SEVERITIES[number];
export type Route = typeof ROUTES[number];
export type Priority = typeof PRIORITIES[number];
export type EventKind = typeof EVENT_KINDS[number];
export type Domain = typeof DOMAINS[number];
export type EntityKind = typeof ENTITY_KINDS[number];
export type Provider = typeof PROVIDERS[number];
export type ObservationStatus = typeof OBSERVATION_STATUSES[number];
export type ResourceStatus = typeof RESOURCE_STATUSES[number];
export type ContextMode = typeof CONTEXT_MODES[number];
export type Completeness = typeof COMPLETENESS[number];

/** Source severities that stay visibly urgent whatever the confidence, route or priority label (AGENTS.md). */
export const URGENT_SEVERITIES: readonly Severity[] = ['HIGH', 'CRITICAL'];
/** Sources whose context content the console displays; financial (PowerOffice) and M365 content are never shown. */
export const DISPLAYED_SYSTEMS: readonly ContextSystem[] = ['atera', 'huntress'];

/** DB queue page sizes offered by the console (API limit 1..100); the first is the default. */
export const QUEUE_PAGE_SIZES = [25, 50, 100] as const;
export type QueuePageSize = typeof QUEUE_PAGE_SIZES[number];
/** packages/tools/registry.ts read tools the evidence button may call: the only tool names this console ever sends. */
export const EVIDENCE_TOOLS = ['atera.alert.list', 'atera.ticket.get', 'huntress.incident.get'] as const;
export type EvidenceTool = typeof EVIDENCE_TOOLS[number];

/** Response and display bounds (docs/stage5/02_CONTRACTS.md, Runtime validation and bounds). */
export const LIMITS = Object.freeze({
  responseBytes: 4 * 1024 * 1024,
  requestDeadlineMs: 10_000,
  clients: 10_000,
  pickerRows: 250,
  queueItems: 100,
  people: 1000,
  devices: 1000,
  links: 1000,
  resources: 100,
  resourceItems: 1000,
  displayCodePoints: 4000,
  reasonCodes: 100,
  searchLength: 128
});

/** Fixed, bounded failure codes. The only diagnostic text the console ever shows; never a server body or exception message. */
export const FAILURE_CODES = ['UNAUTHORIZED', 'FORBIDDEN', 'NETWORK', 'TIMEOUT', 'HTTP_ERROR', 'RESPONSE_INVALID', 'RESPONSE_TOO_LARGE'] as const;
export type FailureCode = typeof FAILURE_CODES[number];

export interface ClientSummary { readonly id: string; readonly name: string }
/** The validated identity of a fetched ClientContextV1; its displayed projection is ContextView below. */
export interface ContextIdentity {
  readonly workspaceId: string; readonly clientId: string; readonly clientName: string;
  readonly mode: ContextMode; readonly completeness: Completeness; readonly generatedAt: string;
}

// Validated projections retained by the console (docs/stage5/S5B_IMPLEMENTATION_BRIEF_RC2.md, Field allowlists). Each is an
// explicit copy made by a validator: no raw response object is ever retained, spread or rendered. Person.email, normalized
// facts/externalDevice/receivedAt, safeErrorCode and every undisplayed field are never copied.
export interface PersonView { readonly id: string; readonly displayName: string }
export interface DeviceView { readonly id: string; readonly hostname: string; readonly personId: string | null }
/** A CONFIRMED Atera/Huntress link of the context (anything else is invalid or not displayed). */
export interface LinkView {
  readonly connectionId: string; readonly system: ContextSystem; readonly resourceType: ResourceType;
  readonly externalId: string; readonly entityId: string; readonly entityKind: EntityKind;
}

/** DB SnapshotItem projection. `status` and `priority` are the source's own free text. */
export interface SnapshotItemView {
  readonly shape: 'snapshot'; readonly externalId: string; readonly title: string; readonly status: string;
  readonly severity: Severity | null; readonly priority: string | null;
  readonly device: { readonly resourceType: ResourceType; readonly externalId: string } | null;
  readonly occurredAt: string | null; readonly updatedAt: string | null;
}
/** FIXTURE normalized alert/incident projection (scope and source tuple verified, not repeated here). */
export interface FixtureEventView {
  readonly shape: 'fixture-event'; readonly externalEventId: string; readonly revision: string; readonly kind: EventKind;
  readonly summary: string; readonly sourceSeverity: Severity; readonly occurredAt: string;
}
export interface FixtureTicketView { readonly shape: 'fixture-ticket'; readonly id: string; readonly title: string; readonly status: string }
export type StoredItem = SnapshotItemView | FixtureEventView | FixtureTicketView;

/** A ResourceView: items exactly for OK/STALE/FIXTURE, null (unavailable, never empty) for ERROR/MISSING. */
export interface StoredRead {
  readonly source: System; readonly resourceType: ResourceType; readonly connectionId: string | null; readonly status: ResourceStatus;
  readonly asOf: string | null; readonly lastSuccessAt: string | null; readonly truncated: boolean;
  readonly items: readonly StoredItem[] | null;
}

/** The displayed context: identity plus Atera/Huntress graph rows and resources. Observations are read by the queue. */
export interface ContextView extends ContextIdentity {
  readonly people: readonly PersonView[]; readonly devices: readonly DeviceView[]; readonly links: readonly LinkView[];
  readonly resources: readonly StoredRead[];
}

export interface ObservationItem {
  readonly id: string; readonly eventKey: string; readonly source: System; readonly connectionId: string; readonly resourceType: ResourceType;
  readonly externalEventId: string; readonly revision: string; readonly entityId: string | null; readonly decisionRunId: string | null;
  readonly kind: EventKind; readonly domain: Domain; readonly severity: Severity; readonly priority: Priority; readonly route: Route;
  readonly confidence: number; readonly provider: Provider; readonly reasonCodes: readonly string[]; readonly conflictOfEventKey: string | null;
  readonly status: ObservationStatus; readonly acknowledgedAt: string | null; readonly resolvedAt: string | null;
  readonly supersededById: string | null; readonly summary: string; readonly occurredAt: string; readonly createdAt: string; readonly updatedAt: string;
}

/** DB queue selection: explicit statuses/severities (canonical enum order, non-empty, unique) and page size. */
export interface QueueQuery { readonly statuses: readonly ObservationStatus[]; readonly severities: readonly Severity[]; readonly limit: QueuePageSize }
/** Position of the one retained DB page: the cursor it was requested with (null = first page) and its 1-based number. */
export interface QueuePosition { readonly cursor: string | null; readonly number: number }

/** One validated queue response in server order. Counts/total describe this response's selection only. */
export interface QueuePage {
  readonly mode: ContextMode; readonly items: readonly ObservationItem[]; readonly counts: Readonly<Record<Severity, number>>;
  readonly total: number; readonly truncated: boolean; readonly nextCursor: string | null;
}

/** Validated evidence for one selected observation, bound to its captured source tuple. */
export interface EvidenceView {
  readonly observationId: string; readonly tool: EvidenceTool; readonly mode: ContextMode;
  readonly status: ResourceStatus; readonly asOf: string | null; readonly lastSuccessAt: string | null; readonly truncated: boolean;
  /** Items of the bounded stored read before exact-ID filtering (list tool), or returned by the get tool; null when unavailable. */
  readonly readCount: number | null;
  /** Items whose stored ID equals the selected source ID; null for ERROR/MISSING. */
  readonly items: readonly StoredItem[] | null;
  readonly correlationId: string | null; readonly executionId: string | null;
}
