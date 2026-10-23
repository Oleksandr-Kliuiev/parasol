import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { ActionRequest } from '../actions/types';
import type { ContractListItem, QuantityModel } from '../contracts/types';

/** The record of a vendor the customer is linked to. */
export interface CustomerServiceLink {
  externalId: string;
  /** Null until a read of the vendor stored the record. */
  name: string | null;
  linkedAt: string;
  method: string;
}

/**
 * One vendor the customer can be connected to (M43): its link, or the code of what refuses creating it now (the same codes the action
 * preview gives), the parameters to start from and the vendor's console for what its API cannot do.
 */
export interface CustomerService {
  system: string;
  kind: string;
  enabled: boolean;
  link: CustomerServiceLink | null;
  block: string | null;
  simulated: boolean;
  defaults: Record<string, string | null>;
  consoleUrl: string | null;
  /** The name of a record at the vendor, named like the customer and linked to nobody, that blocks creating it (VND_EXISTS_AT_VENDOR). */
  existing?: string | null;
}

export interface CustomerServices {
  organizationId: string;
  name: string;
  services: CustomerService[];
}

export const onboardingKeys = {
  services: (organizationId: string) => ['onboarding', 'services', organizationId] as const,
};

/** What the wizard starts from; asked only by those who may link customers (integrations.manage). */
export function useCustomerServices(organizationId: string, enabled = true) {
  return useQuery({
    queryKey: onboardingKeys.services(organizationId),
    enabled,
    queryFn: async ({ signal }) =>
      (await api.get<CustomerServices>(`/api/v1/integrations/organizations/${organizationId}/services`, signal)).data,
  });
}

/** CloudAlly's data centers in the EU (the server refuses any other); the first is the default when none is configured. */
export const euRegions = ['EU', 'EU_FRANKFURT', 'EU_PARIS', 'EU_STOCKHOLM', 'EU_ZURICH'] as const;

/** The quantity model a vendor's service is billed by (M43). */
export const modelOf: Record<string, QuantityModel> = {
  atera: 'PerAteraDevice',
  huntress: 'PerHuntressAgent',
  cloudally: 'PerBackupSeat',
};

/** What the person chose to create for one vendor, with the fields its creation takes. */
export interface CreateChoice {
  system: string;
  kind: string;
  create: boolean;
  key: string;
  email: string;
  region: string;
}

/** Huntress's organization key as the server takes it: lower-case letters, digits and inner hyphens, at most 64 characters. */
export const keyValid = (key: string) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(key);

/** A plausible address: the server checks it again. */
export const emailValid = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.trim().length <= 254;

/** Whether a chosen creation has what it needs; one not chosen always does. */
export function choiceValid(choice: CreateChoice) {
  if (!choice.create) return true;
  if (choice.system === 'huntress') return keyValid(choice.key);
  if (choice.system === 'cloudally') return emailValid(choice.email) && (euRegions as readonly string[]).includes(choice.region);
  return true;
}

/** The choice a service starts with: created when it can be, with the server's defaults. */
export function initialChoice(service: CustomerService): CreateChoice {
  const region = service.defaults.region ?? 'EU';
  return {
    system: service.system,
    kind: service.kind,
    create: service.link === null && service.block === null,
    key: service.defaults.key ?? '',
    email: service.defaults.email ?? '',
    region: (euRegions as readonly string[]).includes(region) ? region : 'EU',
  };
}

/** The mapping screen's list of a vendor's customers, where an existing record is linked by hand. */
export const mappingsOf: Record<string, string> = {
  atera: '/admin/mappings?system=atera&type=Customer',
  huntress: '/admin/mappings?system=huntress&type=Organization',
  cloudally: '/admin/mappings?system=cloudally&type=Customer',
};

/** The vendor action that creates the customer (M39.1 path): its target is the CRM organization. */
export function createRequest(choice: CreateChoice, organizationId: string): ActionRequest {
  const parameters: Record<string, unknown> = choice.system === 'huntress' ? { key: choice.key.trim() }
    : choice.system === 'cloudally' ? { email: choice.email.trim(), region: choice.region }
      : {};
  return { system: choice.system, kind: choice.kind, targetType: 'organization', targetId: organizationId, parameters };
}

/**
 * A contract line the wizard adds for one vendor's service. Until the person ticks or unticks it (<c>decided</c>), it is added
 * unless one of the customer's open contracts already bills the service per unit from the line's first day on.
 */
export interface LineChoice {
  system: string;
  model: QuantityModel;
  add: boolean;
  decided?: boolean;
  product: { id: string; sku: string; name: string } | null;
  estimate: string;
}

/** A contract's line as far as billing the same service twice goes. */
export interface BilledLine {
  contractId: string;
  contractNumber: string;
  quantityModel: string;
  validTo: string | null;
}

/**
 * The open contract that already bills a price kind on or after <paramref name="from"/>: a line of the kind without an end, or one that
 * ends on that day or later — a line that starts later counts too, so a second line never doubles what the collector bills.
 */
export const billedBy = (lines: BilledLine[], model: string, from: string) =>
  lines.find((l) => l.quantityModel === model && (l.validTo === null || l.validTo >= from)) ?? null;

/** The lines with their boxes as the customer's contracts leave them: one the person has not decided follows what none bills yet. */
export const withContract = (lines: LineChoice[], billed: BilledLine[], from: string) =>
  lines.map((line) => (line.decided ? line : { ...line, add: billedBy(billed, line.model, from) === null }));

/** A contract lines can be added to: anything but an ended one. */
export const openContract = (contract: Pick<ContractListItem, 'status'>) => contract.status !== 'Ended';

/** The first day of a new line: a draft's start, else today or the contract's start when that comes later (as the line form does). */
export const lineStart = (contract: { status: string; startDate: string }, today: string) =>
  contract.status === 'Draft' || contract.startDate > today ? contract.startDate : today;

/** A whole number from 0, as the line's quantity until the first count. */
export const estimateValid = (estimate: string) => /^\d{1,7}$/.test(estimate.trim());

export const lineValid = (line: LineChoice) => !line.add || (line.product !== null && estimateValid(line.estimate));
