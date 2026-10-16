export const subscriptionSources = ['PartnerCenter', 'Distributor', 'Manual'] as const;
export type SubscriptionSource = (typeof subscriptionSources)[number];
export type SubscriptionStatus = 'Active' | 'Suspended' | 'Deleted' | 'Pending';
export type SubscriptionTerm = 'Unknown' | 'P1M' | 'P1Y' | 'P3Y';
export type SubscriptionBillingCycle = 'Unknown' | 'Monthly' | 'Annual';

export interface Subscription {
  id: string;
  source: SubscriptionSource;
  subscriptionId: string;
  cspCustomerName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  offerId: string;
  offerName: string | null;
  sku: string | null;
  quantity: number;
  status: SubscriptionStatus;
  term: SubscriptionTerm;
  billingCycle: SubscriptionBillingCycle;
  startDate: string | null;
  commitmentEndDate: string | null;
  renewalDate: string | null;
  autoRenew: boolean;
  cancellationWindowEndsAt: string | null;
  cancellationWindowOpen: boolean;
  /** Only for users with finance.cost.read. */
  partnerUnitPrice?: number | null;
  productId: string | null;
  productName: string | null;
  isBilled: boolean;
  syncedAt: string;
}

export interface LicensingSummary {
  subscriptions: number;
  licenses: number;
  renewingSoon: number;
  cancellationWindowOpen: number;
  notBilled: number;
  withoutOrganization: number;
}

export interface LicensingAttention {
  summary: LicensingSummary;
  cancellationWindow: Subscription[];
  renewing: Subscription[];
  notBilled: Subscription[];
}

export interface ImportResult {
  created: number;
  updated: number;
  unchanged: number;
  withoutOrganization: number;
  warnings: string[];
}

/** Bought against assigned for one SKU in a customer's tenant (FR-LIC-03). */
export interface LicenseUsageRow {
  organizationId: string;
  organizationName: string;
  skuPartNumber: string;
  skuId: string;
  purchased: number;
  assigned: number;
  unused: number;
  snapshotDate: string;
  unusedForWholeWindow: boolean;
  windowDays: number;
}

export interface ReconciliationRow {
  organizationId: string | null;
  organizationName: string;
  microsoftCost: number;
  billedRevenue: number;
  margin: number;
  marginPct: number;
  microsoftLines: number;
  notBilled: boolean;
  offersWithoutRevenue: string[];
}

/** What Microsoft charged against what the customers were charged, for one month (FR-LIC-04). */
export interface ReconciliationReport {
  periodStart: string;
  periodEnd: string;
  microsoftCost: number;
  billedRevenue: number;
  margin: number;
  currency: string;
  lines: number;
  rows: ReconciliationRow[];
}
