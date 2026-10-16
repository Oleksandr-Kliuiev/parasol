import type { BillingPeriod, ProductUnit } from '../catalog/types';

export const contractTypes = ['Msp', 'Licensing', 'PowerOfficeSupport', 'HourBank', 'Mixed'] as const;
export type ContractType = (typeof contractTypes)[number];
export const contractStatuses = ['Draft', 'Active', 'Suspended', 'NoticeGiven', 'Ended'] as const;
export type ContractStatus = (typeof contractStatuses)[number];
export const quantityModels = ['Fixed', 'PerAteraDevice', 'PerM365User', 'PerSubscription', 'Manual'] as const;
export type QuantityModel = (typeof quantityModels)[number];
export const deviceFilters = ['All', 'Workstations', 'Servers'] as const;
export type DeviceFilter = (typeof deviceFilters)[number];
export const invoiceFrequencies = ['Monthly', 'Quarterly', 'Yearly'] as const;
export type InvoiceFrequency = (typeof invoiceFrequencies)[number];
export const invoiceTimings = ['InAdvance', 'InArrears'] as const;
export type InvoiceTiming = (typeof invoiceTimings)[number];
export const coverages = ['Business8x5', 'Extended12x5', 'Always24x7'] as const;
export type Coverage = (typeof coverages)[number];

export interface Ref {
  id: string;
  name: string;
}

export interface ContractListItem {
  id: string;
  number: string;
  title: string;
  organization: Ref;
  type: ContractType;
  status: ContractStatus;
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  owner: Ref | null;
  slaName: string | null;
}

export interface ContractLine {
  id: string;
  seriesId: string;
  version: number;
  productId: string;
  sku: string;
  productName: string;
  unit: ProductUnit;
  billingPeriod: BillingPeriod;
  description: string | null;
  quantityModel: QuantityModel;
  deviceFilter: DeviceFilter;
  quantity: number;
  /** Price fields are only present for users with finance.read. */
  unitPrice?: number | null;
  effectiveUnitPrice?: number | null;
  priceSource?: 'Contract' | 'PriceList' | 'ListPrice' | null;
  discountPct?: number;
  amount?: number | null;
  validFrom: string;
  validTo: string | null;
  isCurrent: boolean;
}

export interface Contract {
  id: string;
  number: string;
  organization: Ref;
  title: string;
  type: ContractType;
  status: ContractStatus;
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  renewalTermMonths: number;
  noticePeriodDays: number;
  noticeDeadline: string | null;
  slaPolicy: Ref | null;
  invoiceFrequency: InvoiceFrequency;
  invoiceTiming: InvoiceTiming;
  priceCategory: string | null;
  indexation: boolean;
  nextIndexationDate: string | null;
  customerReference: string | null;
  owner: Ref | null;
  notes: string | null;
  noticeGivenOn: string | null;
  endedOn: string | null;
  renewalCount: number;
  monthlyValue?: number | null;
  currency: string;
  lines: ContractLine[];
  createdAt: string;
  modifiedAt: string | null;
}

export interface ContractRequest {
  organizationId: string;
  title: string;
  type: ContractType;
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  renewalTermMonths: number;
  noticePeriodDays: number;
  slaPolicyId: string | null;
  invoiceFrequency: InvoiceFrequency;
  invoiceTiming: InvoiceTiming;
  priceCategory: string | null;
  indexation: boolean;
  nextIndexationDate: string | null;
  customerReference: string | null;
  ownerId: string | null;
  notes: string | null;
}

export interface LineRequest {
  productId: string;
  description: string | null;
  quantityModel: QuantityModel;
  deviceFilter: DeviceFilter | null;
  quantity: number;
  unitPrice: number | null;
  discountPct: number | null;
  validFrom: string;
  validTo: string | null;
}

export interface PriorityTarget {
  responseMinutes: number;
  resolutionMinutes: number;
}

export interface SlaPolicy {
  id: string;
  name: string;
  coverage: Coverage;
  p1: PriorityTarget;
  p2: PriorityTarget;
  p3: PriorityTarget;
  p4: PriorityTarget;
  includedHoursPerMonth: number;
  overageRate?: number | null;
  afterHoursMultiplier: number;
  coveredWorkTypes: string | null;
  ateraValue: string | null;
  isActive: boolean;
  contractCount: number;
  etag: string;
}

export type SlaPolicyRequest = Omit<SlaPolicy, 'id' | 'contractCount' | 'etag' | 'overageRate'> & { overageRate: number | null };

export type HourBankEntryKind = 'Purchase' | 'Consumption' | 'Adjustment';

export interface HourBankEntry {
  id: string;
  kind: HourBankEntryKind;
  date: string;
  hours: number;
  overageHours: number;
  description: string | null;
  sourceType: string | null;
  createdBy: Ref | null;
  createdAt: string;
}

export interface HourBank {
  id: string;
  organization: Ref;
  contractId: string | null;
  contractNumber: string | null;
  name: string;
  validFrom: string;
  validTo: string | null;
  purchasedHours: number;
  usedHours: number;
  remainingHours: number;
  overageHours: number;
  overageRate?: number | null;
  lowBalancePct: number;
  isLow: boolean;
  status: 'Active' | 'Closed';
  entries: HourBankEntry[] | null;
}

export type ReminderKind = 'ContractEnding' | 'NoticeDeadline' | 'HourBankLow';

export interface Reminder {
  id: string;
  kind: ReminderKind;
  organization: Ref;
  contract: { id: string; number: string; title: string; endDate: string | null; autoRenew: boolean; noticeDeadline: string | null } | null;
  hourBank: { id: string; name: string; remainingHours: number; purchasedHours: number } | null;
  dueDate: string;
  daysBefore: number | null;
  assignee: Ref | null;
  acknowledgedAt: string | null;
}

/** One line of the yearly indexation preview (FR-CON-05). */
export interface IndexationLine {
  seriesId: string;
  productName: string;
  description: string | null;
  quantity: number;
  /** Only for users with finance.read. */
  priceBefore?: number;
  priceAfter?: number;
}

export interface IndexationCandidate {
  contractId: string;
  number: string;
  title: string;
  organization: Ref;
  nextIndexationDate: string | null;
  monthlyBefore?: number;
  monthlyAfter?: number;
  priceListLines: number;
  lines: IndexationLine[];
}

/** Monthly amounts of a set of contracts, summed on the server (DEV-12); hidden from roles without finance. */
export interface IndexationTotals {
  contracts: number;
  monthlyBefore?: number;
  monthlyAfter?: number;
}

export interface IndexationPreview {
  percent: number;
  effectiveFrom: string;
  contracts: IndexationCandidate[];
  totals: IndexationTotals;
}

export interface IndexationResult {
  contracts: number;
  lines: number;
  changed: IndexationCandidate[];
  totals: IndexationTotals;
  /** Requested contracts the preview would not offer on that date; never indexed. */
  skipped: string[];
}
