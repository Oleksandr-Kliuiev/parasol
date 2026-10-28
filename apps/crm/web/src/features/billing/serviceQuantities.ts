import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

/** The counted sources a contract line can bill (M43), in the order the card shows them. */
export type CountedModel = 'PerAteraDevice' | 'PerHuntressAgent' | 'PerBackupSeat';

export type ServiceQuantityStatus = 'None' | 'Counted' | 'NoReading' | 'NotOnContract';

/** A contract line in force today that bills a counted source; `billed` is what the next basis would take. */
export interface ServiceQuantityLine {
  contractId: string;
  contractNumber: string;
  lineId: string;
  productName: string;
  deviceFilter: string | null;
  estimate: number;
  billed: number;
  validFrom: string;
  validTo: string | null;
}

/** One line of what CloudAlly bills the partner; price and total come only to readers of purchase prices. */
export interface ServiceBillLine {
  day: string;
  account: string;
  accountName: string | null;
  service: string | null;
  source: string;
  seats: number | null;
  accounts: number | null;
  /** How many users the line bills, as the billing basis counts them: seats where the plan sells seats, else accounts. */
  users: number | null;
  price?: number | null;
  total?: number | null;
  currency: string | null;
}

export interface ServiceQuantity {
  model: CountedModel;
  source: string;
  count: number | null;
  /** Atera's devices by type (Workstation, Server, …). */
  detail: Record<string, number> | null;
  /** The day the count was read; null for devices counted from the list now, or no count. */
  readOn: string | null;
  stale: boolean;
  status: ServiceQuantityStatus;
  lines: ServiceQuantityLine[];
  billLines: ServiceBillLine[];
}

export interface ServiceQuantities {
  organizationId: string;
  asOf: string;
  staleQuantityDays: number;
  services: ServiceQuantity[];
}

export const serviceQuantityKeys = {
  one: (organizationId: string) => ['billing', 'service-quantities', organizationId] as const,
};

/** What the customer's services count against its contract (M43): the same readings the next billing run takes. */
export function useServiceQuantities(organizationId: string, enabled = true) {
  return useQuery({
    queryKey: serviceQuantityKeys.one(organizationId),
    enabled,
    queryFn: async ({ signal }) =>
      (await api.get<ServiceQuantities>(`/api/v1/billing/organizations/${organizationId}/service-quantities`, signal)).data,
  });
}
