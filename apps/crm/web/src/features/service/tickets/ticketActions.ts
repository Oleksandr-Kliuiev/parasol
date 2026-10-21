import type { ReactNode } from 'react';
import type { ActionRequest, VendorAction } from '../../actions/types';
import type { TicketDetail } from '../types';

/** Atera's standard ticket statuses and priorities, as the server's ticket actions accept them. */
export const ticketStatuses = ['Open', 'Pending', 'Resolved', 'Closed'] as const;
export const ticketPriorities = ['Low', 'Medium', 'High', 'Critical'] as const;

/** An action asked from the ticket panel: what is sent, and what its confirmation is called. */
export interface TicketActionAsk {
  request: ActionRequest;
  title: string;
  confirm: string;
  /** What the preview cannot say in words, such as the text of a reply. */
  details?: ReactNode;
  /** Told when the command is saved: the action goes ahead whatever happens to the dialog (a composer empties itself). */
  onAccepted?: (action: VendorAction) => void;
  /** Told the outcome once the worker has one. */
  onFinished?: (action: VendorAction) => void;
}

export const ticketRequest = (ticket: Pick<TicketDetail, 'system' | 'externalId'>, kind: string, parameters: Record<string, unknown> = {}): ActionRequest =>
  ({ system: ticket.system, kind, targetType: 'ticket', targetId: String(ticket.externalId), parameters });
