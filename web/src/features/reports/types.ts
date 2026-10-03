export interface MoneyByLabel {
  label: string;
  /** Only for users with finance.read. */
  amount?: number;
}

export interface RevenueMonth {
  year: number;
  month: number;
  totalExVat?: number;
  byBusinessLine: MoneyByLabel[];
}

export interface RecurringPanel {
  mrr?: number;
  arr?: number;
  contracts: number;
  byType: MoneyByLabel[];
}

export interface PipelinePanel {
  open: number;
  stale: number;
  weightedForecast?: number;
  openValue?: number;
  wonLast90Days: number;
  wonAmountLast90Days?: number;
  lostLast90Days: number;
}

export interface InvoicePanel {
  open: number;
  outstanding?: number;
  overdue?: number;
  overdueCount: number;
}

export interface RenewalItem {
  contractId: string;
  number: string;
  title: string;
  organization: string;
  endDate: string;
  daysLeft: number;
  autoRenew: boolean;
  noticeDeadline: string | null;
}

export interface UtilizationItem {
  technician: string;
  billedHours: number;
  coveredHours: number;
  hourBankHours: number;
  nonBillableHours: number;
  totalHours: number;
  billablePct: number;
}

export interface LicensePanel {
  subscriptions: number;
  licenses: number;
  cancellationWindowOpen: number;
  renewingSoon: number;
  notBilled: number;
  withoutOrganization: number;
}

export interface ServicePanel {
  openTickets: number;
  unassignedTickets: number;
  criticalAlerts: number;
  warningAlerts: number;
  devices: number;
  devicesOffline: number;
}

export interface Dashboard {
  asOf: string;
  recurring: RecurringPanel;
  revenue: RevenueMonth[];
  invoices: InvoicePanel;
  pipeline: PipelinePanel;
  renewals: RenewalItem[];
  utilization: UtilizationItem[];
  licenses: LicensePanel;
  service: ServicePanel;
}

/** Margin of one customer for a period (FR-RPT-02); money fields depend on the reader's permissions. */
export interface CustomerMarginRow {
  organizationId: string;
  organizationName: string;
  revenue?: number;
  licenseRevenue?: number;
  hourRevenue?: number;
  licenseCost?: number;
  hourCost?: number;
  margin?: number;
  marginPct?: number;
  hours: number;
  costIncomplete: boolean;
}

export interface MarginReport {
  periodStart: string;
  periodEnd: string;
  revenue?: number;
  cost?: number;
  margin?: number;
  marginPct?: number;
  hourlyCost: number;
  customers: number;
  withoutLicenseCost: number;
  rows: CustomerMarginRow[];
}
