// Console view state (docs/stage5/03_SECURITY_AND_STATE.md, State machine). DOM-free and token-free: nothing here can
// hold or reveal the credential. Only validated projections are ever placed in this state.
import type { ClientSummary, ContextView, EvidenceView, FailureCode, QueuePage, QueuePosition, QueueQuery } from './contracts.ts';
import { ASK_CAPABILITY_IDLE, askIdle } from './ask-state.ts';
import type { AskCapabilityState, AskState } from './ask-state.ts';
import { DEFAULT_QUEUE_QUERY, FIRST_PAGE } from './queue-query.ts';

export type SessionState = 'DISCONNECTED' | 'CONNECTING' | 'READY';
/** Fixed reasons for the disconnected screen. */
export type SessionNotice = 'TOKEN_FORMAT' | 'UNAUTHORIZED' | 'DISCONNECTED' | 'PAGE_HIDDEN' | 'ORIGIN_REFUSED';
export type PanelStatus = 'IDLE' | 'LOADING' | 'READY' | 'ERROR';

export interface Panel<T> { readonly status: PanelStatus; readonly data: T | null; readonly error: FailureCode | null }
export interface Selection { readonly clientId: string; readonly name: string }

export interface ConsoleState {
  readonly session: SessionState;
  readonly notice: SessionNotice | null;
  readonly clients: Panel<readonly ClientSummary[]>;
  /** Set after a 403 cleared the selected scope and refreshed the picker once. */
  readonly scopeDenied: boolean;
  readonly search: string;
  readonly selection: Selection | null;
  /** The validated, displayed context of the selected client. Queue and evidence never start before it is READY. */
  readonly context: Panel<ContextView>;
  /** DB queue selection and the position of the one retained page (fixture queues ignore both). */
  readonly queueQuery: QueueQuery;
  readonly queuePosition: QueuePosition;
  readonly queue: Panel<QueuePage>;
  /** ID of the selected observation of the current queue page; never carried to another page, filter or client. */
  readonly observationId: string | null;
  readonly evidence: Panel<EvidenceView>;
  /** Ask Atlas capability of the current credential (ask-state.ts); never carried to another credential. */
  readonly askCapability: AskCapabilityState;
  /** The one Ask answer/pending question; an older separate read that never changes the panels above. */
  readonly ask: AskState;
}

export const idle = <T>(): Panel<T> => ({ status: 'IDLE', data: null, error: null });
export const loading = <T>(): Panel<T> => ({ status: 'LOADING', data: null, error: null });
export const ready = <T>(data: T): Panel<T> => ({ status: 'READY', data, error: null });
export const failed = <T>(error: FailureCode): Panel<T> => ({ status: 'ERROR', data: null, error });

/** Everything that belongs to one selected client: cleared together on selection, 403 and disconnect. */
export function emptyScope(): Pick<ConsoleState, 'context' | 'queueQuery' | 'queuePosition' | 'queue' | 'observationId' | 'evidence'> {
  return { context: idle(), queueQuery: DEFAULT_QUEUE_QUERY, queuePosition: FIRST_PAGE, queue: idle(), observationId: null, evidence: idle() };
}

export function disconnectedState(notice: SessionNotice | null): ConsoleState {
  return { session: 'DISCONNECTED', notice, clients: idle(), scopeDenied: false, search: '', selection: null, ...emptyScope(),
    askCapability: ASK_CAPABILITY_IDLE, ask: askIdle(0) };
}
