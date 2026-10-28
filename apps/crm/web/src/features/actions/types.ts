/** The confirmation an action needs (M39.1): one button, a reason, or a fresh sign-in, the typed name, a reason and a hold. */
export type ActionLevel = 'Standard' | 'Disruptive' | 'Destructive';

/** Where an action stands; the last six are outcomes and only Uncertain waits for a person. */
export type ActionStatus = 'Scheduled' | 'Queued' | 'Sending' | 'Succeeded' | 'Simulated' | 'Skipped' | 'Rejected' | 'Failed' | 'Uncertain' | 'Cancelled';

export const waitingStatuses: readonly ActionStatus[] = ['Scheduled', 'Queued', 'Sending'];

export const isWaiting = (status: ActionStatus) => waitingStatuses.includes(status);

/** What an action is asked for: the vendor, the kind, the target as the CRM names it and the kind's parameters. */
export interface ActionRequest {
  system: string;
  kind: string;
  targetType: string;
  targetId: string;
  parameters: Record<string, unknown>;
}

export interface ActionTarget {
  type: string;
  id: string;
  name: string;
  organizationId: string | null;
  organizationName: string | null;
  externalCustomerId: string | null;
  url: string | null;
}

/** One consequence, as a code the interface translates and the values it names. */
export interface ActionEffect {
  code: string;
  values: Record<string, string | null>;
}

export interface ActionBlock {
  code: string;
  message: string;
}

export interface ActionConfirmation {
  reason: boolean;
  typedName: boolean;
  freshSignIn: boolean;
  holdSeconds: number;
}

/** The preview, from saved data only; the token comes back with the command and is valid for ten minutes. */
export interface ActionPreview {
  previewToken: string | null;
  expiresAt: string | null;
  system: string;
  kind: string;
  level: ActionLevel;
  target: ActionTarget;
  effects: ActionEffect[];
  block: ActionBlock | null;
  confirmation: ActionConfirmation;
  simulated: boolean;
  paused: boolean;
}

export interface VendorAction {
  id: string;
  system: string;
  kind: string;
  level: ActionLevel;
  targetType: string;
  targetId: string;
  targetName: string;
  organizationId: string | null;
  organizationName: string | null;
  parameters: Record<string, unknown>;
  reason: string | null;
  status: ActionStatus;
  outcomeCode: string | null;
  outcome: string | null;
  reference: string | null;
  attempts: number;
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: string;
  notBefore: string;
  startedAt: string | null;
  completedAt: string | null;
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string | null;
  closeReason: string | null;
  /** Parasoll's ticket the action concerns (its target, or the ticket its hours were recorded on). */
  ticketId: string | null;
  /** Where to check the action at the vendor: the ticket there. */
  vendorUrl: string | null;
  etag: string;
  /** The batch it was asked in (M45: one confirmation for many targets); null when asked alone. */
  batchId?: string | null;
}

/**
 * The actions on one target of a list's page (M39): waiting for the worker, done (or already so at the vendor), and without a clear
 * answer, with the newest of those so the row can open it. A target without actions is not in the answer.
 */
export interface ActionTargetFacts {
  targetId: string;
  waiting: number;
  done: number;
  uncertain: number;
  checkId: string | null;
}

/** A kind the person may ask for now (M39.3): the vendor's switches and their access let it through; an allow-list may still refuse a customer. */
export interface ActionKind {
  system: string;
  kind: string;
  targetType: string;
  level: ActionLevel;
  simulated: boolean;
  limitedToCustomers: boolean;
  /** It may also be asked for many targets with one confirmation (M45); never a destructive kind. */
  batch?: boolean;
}

/** A page of the log; `uncertain` and `waiting` count the whole filter. */
export interface ActionPage {
  items: VendorAction[];
  nextCursor: string | null;
  totalCount: number;
  uncertain: number;
  waiting: number;
}

/** Many targets of one kind asked for with one confirmation (M45), with the parameters every one of them takes. */
export interface ActionBatchRequest {
  system: string;
  kind: string;
  targetType: string;
  targetIds: string[];
  parameters: Record<string, unknown>;
}

/** One target of a batch preview: its saved copy (null when Parasoll has none) and what keeps it out, if anything. */
export interface ActionBatchTarget {
  targetId: string;
  target: ActionTarget | null;
  block: ActionBlock | null;
  /** The action of the same kind someone already asked for it, not sent yet: it is not asked twice. */
  waitingActionId: string | null;
}

/** The preview of a batch, from saved data only: `ready` targets get an action each; the token is valid for ten minutes. */
export interface ActionBatchPreview {
  previewToken: string | null;
  expiresAt: string | null;
  system: string;
  kind: string;
  level: ActionLevel;
  targets: ActionBatchTarget[];
  ready: number;
  /** What keeps the whole batch back (the kind switched off, writing off). */
  block: ActionBlock | null;
  confirmation: ActionConfirmation;
  simulated: boolean;
  paused: boolean;
}

/** What the command did with one target: the action asked for it, or the code of what kept it out. */
export interface ActionBatchItem {
  targetId: string;
  actionId: string | null;
  status: ActionStatus | null;
  code: string | null;
}

/** The batch the command saved; `repeated` when an earlier answer of the same confirmation had saved it. */
export interface ActionBatchResult {
  batchId: string | null;
  items: ActionBatchItem[];
  asked: number;
  repeated: boolean;
}

/** One action of a batch as it stands now. */
export interface ActionBatchEntry {
  actionId: string;
  targetId: string;
  targetName: string;
  organizationId: string | null;
  organizationName: string | null;
  status: ActionStatus;
  outcomeCode: string | null;
  completedAt: string | null;
}

/** A batch as it stands now: how many wait and how many came to each outcome, with its actions when asked for. */
export interface ActionBatchState {
  id: string;
  system: string;
  kind: string;
  total: number;
  waiting: number;
  succeeded: number;
  skipped: number;
  simulated: number;
  /** Refused, failed or cancelled: nothing happened at the vendor. */
  failed: number;
  uncertain: number;
  items: ActionBatchEntry[];
}
