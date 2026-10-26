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
}

/** A page of the log; `uncertain` and `waiting` count the whole filter. */
export interface ActionPage {
  items: VendorAction[];
  nextCursor: string | null;
  totalCount: number;
  uncertain: number;
  waiting: number;
}
