// Mirrors the crm-web API contracts (JSON camelCase, enums as strings).

export type OrganizationStatus = 'Lead' | 'Prospect' | 'Customer' | 'Former' | 'Partner';
export const organizationStatuses: OrganizationStatus[] = ['Lead', 'Prospect', 'Customer', 'Former', 'Partner'];

export type RegistryStatus = 'Unknown' | 'Active' | 'UnderDissolution' | 'Bankrupt' | 'Deleted' | 'NotFound';

export interface Address {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
}

export interface UserRef {
  id: string;
  displayName: string;
}

export interface UserSummary extends UserRef {
  email: string | null;
  isActive: boolean;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: string | null;
  /** Every item the filter matches, for lists that count (DEV-12). */
  totalCount?: number | null;
}

export interface OrganizationListItem {
  id: string;
  name: string;
  orgNumber: string | null;
  status: OrganizationStatus;
  city: string | null;
  accountManager: UserRef | null;
  registryStatus: RegistryStatus;
}

export interface OrganizationRequest {
  name: string;
  orgNumber: string | null;
  legalForm: string | null;
  status: OrganizationStatus;
  naceCode: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  invoiceEmail: string | null;
  ehfEnabled: boolean;
  accountManagerId: string | null;
  primaryTechnicianId: string | null;
  postalAddress: Address | null;
  visitAddress: Address | null;
  billingAddress: Address | null;
  domains: string[];
}

/** A company above or below this one in a group (FR-CUS-07). */
export interface OrganizationGroupMember {
  id: string;
  name: string;
  status: OrganizationStatus;
  billedThroughParent: boolean;
}

export interface SetParentRequest {
  parentId: string | null;
  billedThroughParent: boolean;
}

export interface Organization {
  id: string;
  name: string;
  orgNumber: string | null;
  legalForm: string | null;
  status: OrganizationStatus;
  naceCode: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  invoiceEmail: string | null;
  ehfEnabled: boolean;
  accountManager: UserRef | null;
  primaryTechnician: UserRef | null;
  postalAddress: Address;
  visitAddress: Address;
  billingAddress: Address;
  domains: string[];
  registryStatus: RegistryStatus;
  registryCheckedAt: string | null;
  parent: OrganizationGroupMember | null;
  billedThroughParent: boolean;
  children: OrganizationGroupMember[];
  createdAt: string;
  modifiedAt: string | null;
}

export type ContactRole = 'DecisionMaker' | 'Technical' | 'Billing' | 'EndUser';
export const contactRoles: ContactRole[] = ['DecisionMaker', 'Technical', 'Billing', 'EndUser'];

export interface OrganizationContactItem {
  contactId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  title: string | null;
  roles: ContactRole[];
  isPrimary: boolean;
  isActive: boolean;
}

export interface CreateOrganizationContactRequest {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  preferredLanguage: string | null;
  title: string | null;
  roles: ContactRole[];
  isPrimary: boolean;
}

export interface AffiliationRequest {
  title: string | null;
  roles: ContactRole[];
  isPrimary: boolean;
  isActive: boolean;
}

export interface ContactPersonRequest {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  preferredLanguage: string | null;
}

export interface ContactAffiliation {
  organizationId: string;
  organizationName: string;
  title: string | null;
  roles: ContactRole[];
  isPrimary: boolean;
  isActive: boolean;
}

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  preferredLanguage: string | null;
  affiliations: ContactAffiliation[];
  createdAt: string;
  modifiedAt: string | null;
}

export interface CreatedContact {
  contactId: string;
  linkedExisting: boolean;
}

export interface RegistryAddress {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
}

export interface RegistryOrganization {
  orgNumber: string;
  name: string;
  legalForm: string | null;
  legalFormDescription: string | null;
  naceCode: string | null;
  naceDescription: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  businessAddress: RegistryAddress | null;
  postalAddress: RegistryAddress | null;
  status: RegistryStatus;
}

export interface RegistryLookup {
  status: RegistryStatus;
  organization: RegistryOrganization | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  userId: string | null;
  userName: string | null;
  action: 'Create' | 'Update' | 'Delete' | 'Erase' | string;
  module: string;
  entityType: string;
  entityId: string;
  /** Field diffs ({ old, new }) for edits; arbitrary details for other actions (export, trigger…). */
  changes: Record<string, unknown> | null;
  correlationId: string | null;
  /** DEV-11: the record was erased on a privacy request, so the entry keeps only the fact (changes are withheld). */
  erased?: boolean;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: number | null;
}

export type AuthMode = 'Entra' | 'Development';

export interface CurrentUser {
  id: string;
  displayName: string;
  email: string | null;
  preferredLanguage: string | null;
  roles: string[];
  permissions: string[];
  authMode: AuthMode;
  /** What the user sees of the scoped records (DEV-09): every quote or project, or only their own / assigned ones. */
  recordScope: RecordScope;
  /** The My day layout the user chose (M38), or null before they choose; read it through `myDayProfile`. */
  myDayLayout?: string | null;
}

export interface RecordScope {
  mode: 'Restricted' | 'Open';
  allQuotes: boolean;
  allProjects: boolean;
}

export interface SearchHit {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
}

export interface SearchResponse {
  query: string;
  groups: Array<{ group: string; items: SearchHit[] }>;
}

export type DuplicateReason = 'SameName' | 'SharedDomain' | 'SameEmailDomain' | 'SamePhone';

export interface DuplicateSide {
  id: string;
  name: string;
  orgNumber: string | null;
  status: OrganizationStatus;
  city: string | null;
  email: string | null;
  phone: string | null;
  domains: string[];
  activeContacts: number;
  createdAt: string;
}

export interface DuplicatePair {
  first: DuplicateSide;
  second: DuplicateSide;
  reasons: DuplicateReason[];
}

export interface MergeResult {
  mergeId: string;
  targetOrganizationId: string;
  sourceOrganizationId: string;
  movedContacts: number;
}

export interface MergeListItem {
  id: string;
  targetOrganizationId: string;
  targetName: string;
  sourceOrganizationId: string;
  sourceName: string;
  mergedAt: string;
  mergedBy: UserRef | null;
  undoneAt: string | null;
  canUndo: boolean;
}

export interface RecurringJob {
  id: string;
  cron: string;
  timeZone: string | null;
  nextExecution: string | null;
  lastExecution: string | null;
  lastState: string | null;
  error: string | null;
}

export interface SyncRun {
  id: string;
  system: string;
  job: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'Running' | 'Succeeded' | 'Failed' | 'Skipped';
  read: number;
  changed: number;
  failed: number;
  message: string | null;
}

export type LinkMethod = 'Automatic' | 'Manual' | 'Imported' | 'Exported';

export interface ExternalRecordItem {
  id: string;
  system: string;
  externalType: string;
  externalId: string;
  displayName: string;
  orgNumber: string | null;
  email: string | null;
  phone: string | null;
  domain: string | null;
  parentExternalId: string | null;
  lastSeenAt: string;
  externalChangedAt: string | null;
  isGone: boolean;
  link: { linkId: string; entityId: string; entityName: string | null; method: LinkMethod; linkedAt: string } | null;
  suggestions: Array<{ entityId: string; name: string; orgNumber: string | null; reasons: string[] }>;
}

export interface RecordPage {
  items: ExternalRecordItem[];
  nextCursor: string | null;
  total: number;
  unlinked: number;
}

export interface IntegrationStatus {
  system: string;
  enabled: boolean;
  recordTypes: string[];
  records: number;
  unlinked: number;
  pendingOutbound: number;
  failedOutbound: number;
  /** Held during an incident (runbook 05): jobs skip and the outbound queue waits. */
  paused: boolean;
  pauseReason: string | null;
  pausedAt: string | null;
  pausedBy: string | null;
}

/** A connection test runs in crm-worker, the only host with the provider credentials; `Running` until it answers. */
export interface ConnectionTestStatus {
  id: string | null;
  system: string;
  status: 'Running' | 'Succeeded' | 'Failed';
  success: boolean | null;
  message: string | null;
  requestedAt: string | null;
  finishedAt: string | null;
}

export interface IntegrationCapability {
  system: string;
  enabled: boolean;
  canCreateOrganization: boolean;
}

export interface EntityLink {
  id: string;
  system: string;
  externalType: string;
  externalId: string;
  displayName: string | null;
  method: LinkMethod;
  linkedAt: string;
}

export interface BulkResult {
  linked: number;
  created: number;
  skipped: number;
  failed: number;
  errors: string[];
  dryRun: boolean;
}

/** Where a domain event stands in its module's outbox (DEV-07). */
export type OutboxStatus = 'Pending' | 'Processing' | 'Processed' | 'DeadLetter' | 'Quarantined';

/** An undelivered domain event, without its payload: only the names of its fields (it may carry personal data). */
export interface OutboxMessageItem {
  id: string;
  module: string;
  eventType: string;
  status: OutboxStatus;
  occurredAt: string;
  attempts: number;
  replays: number;
  nextAttemptAt: string | null;
  deadLetteredAt: string | null;
  lastError: string | null;
  deliveredHandlers: string[];
  payloadBytes: number;
  payloadFields: string[];
  replayRequested: boolean;
}

export interface OutboxModuleCount {
  module: string;
  pending: number;
  processing: number;
  deadLetter: number;
  quarantined: number;
}

export interface OutboxOverview {
  counts: OutboxModuleCount[];
  items: OutboxMessageItem[];
}

export type OutboundStatus = 'Pending' | 'Succeeded' | 'Failed' | 'DeadLetter' | 'Cancelled';

export interface OutboundOperation {
  id: string;
  etag: string;
  system: string;
  operation: string;
  entityType: string;
  entityId: string;
  status: OutboundStatus;
  attempts: number;
  createdAt: string;
  nextAttemptAt: string;
  completedAt: string | null;
  lastError: string | null;
  result: string | null;
}

export type BillingDetailsMaster = 'Crm' | 'PowerOffice';
