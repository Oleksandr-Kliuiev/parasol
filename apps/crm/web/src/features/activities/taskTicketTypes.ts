/** A saved Service row whose current customer ownership has been verified by the API. */
export interface TicketWorkRef {
  id: string;
  organizationId: string;
  externalId: number;
  title: string;
  status: string;
  importedAt: string;
}

export interface TaskTicketAssociation {
  activityId: string;
  organizationId: string;
  ticketId: string | null;
  ticket: TicketWorkRef | null;
  available: boolean;
  etag: string;
}
