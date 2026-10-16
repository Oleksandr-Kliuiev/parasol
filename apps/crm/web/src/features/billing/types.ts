export const runStatuses = ['Draft', 'Collected', 'InReview', 'Approved', 'Exporting', 'Exported', 'ExportedWithErrors', 'Closed'] as const;
export type RunStatus = (typeof runStatuses)[number];

export const basisStatuses = ['Draft', 'Approved', 'Exported', 'Failed', 'Cancelled', 'ReconciliationRequired'] as const;
export type BasisStatus = (typeof basisStatuses)[number];

export const billingGroups = ['Subscription', 'License', 'HourlyWork', 'HourBank', 'OneOff', 'Info'] as const;
export type BillingGroup = (typeof billingGroups)[number];

export type InvoiceStatus = 'Draft' | 'Sent' | 'PartiallyPaid' | 'Paid' | 'Overdue' | 'Credited';

export interface Ref {
  id: string;
  name: string;
}

export interface Anomaly {
  code: string;
  /** English fallback; known codes are rendered from `args` through i18n (see `anomalyText`). */
  message: string;
  args?: Record<string, string> | null;
}

/** `Payment` and `WriteOff` are never written yet: the accounting system's invoice data cannot prove them. */
export type InvoiceMovementKind = 'BalanceDecrease' | 'CreditNote' | 'BalanceIncrease' | 'Payment' | 'WriteOff';

/** A change of the remaining amount as a sync saw it; `observedOn` is the day of the sync, not the day money moved. */
export interface InvoiceMovement {
  kind: InvoiceMovementKind;
  observedOn: string;
  amount?: number;
  source: string;
}

/** A supplementary run bills, for a closed period, only what no earlier run billed (ADR-013). */
export type RunKind = 'Regular' | 'Supplementary';

export interface RunListItem {
  id: string;
  periodStart: string;
  periodEnd: string;
  kind: RunKind;
  status: RunStatus;
  organizations: number;
  withAnomalies: number;
  /** Only for users with finance.read. */
  totalExVat?: number;
  requiresSecondApproval: boolean;
  collectedAt: string | null;
  approvedAt: string | null;
  exportedAt: string | null;
  closedAt: string | null;
}

export type ApprovalKind = 'First' | 'Second';
export type ApprovalResetReason = 'Recollected' | 'LinesChanged' | 'BasisCancelled' | 'ContentChanged' | 'RuleChanged' | 'Migrated';

/** One approval act about one content revision of the run; `valid` is false once a later revision set it aside (ADR-012). */
export interface Approval {
  kind: ApprovalKind;
  approvedBy: Ref;
  approvedAt: string;
  contentRevision: number;
  valid: boolean;
  invalidatedAt: string | null;
  invalidationReason: ApprovalResetReason | null;
}

export interface Run extends RunListItem {
  exported: number;
  failed: number;
  /** The valid first and second approvals of the current revision. */
  approvedBy: Ref | null;
  secondApprovedBy: Ref | null;
  notes: string | null;
  /** Lines whose source changed after Finance decided about them; the run cannot be approved while any is left. */
  conflicts: number;
  /** Goes up with every collect and every change of the lines; approvals are about one revision. */
  contentRevision: number;
  /** The revision the run was released with. */
  approvedRevision: number | null;
  /** Every approval ever given, including those set aside, oldest first. */
  approvals: Approval[];
  etag: string;
}

export interface BasisListItem {
  id: string;
  organization: Ref;
  status: BasisStatus;
  totalExVat?: number;
  previousPeriodTotal?: number;
  anomalies: Anomaly[];
  lines: number;
  conflicts: number;
  orderNo: string | null;
  exportedAt: string | null;
}

export type LineOrigin = 'Collected' | 'Manual';
export type LineDecision = 'None' | 'Override' | 'Exclusion';
export type LineConflict = 'None' | 'SourceChanged' | 'SourceRemoved' | 'LegacyUnmatched';

/**
 * A line of a basis. Quantity, prices and text are what is invoiced; the `source*` fields are what the source said at the
 * last collect, so a correction or a conflict can be read next to it (ADR-011). Money fields are absent without finance.read.
 */
export interface BasisLine {
  id: string;
  group: BillingGroup;
  productId: string | null;
  productName: string | null;
  productCode: string | null;
  description: string;
  quantity: number;
  unitPrice?: number;
  discountPct?: number;
  vatRate: number;
  lineTotal?: number;
  manuallyAdjusted: boolean;
  sourceRefs: string | null;
  origin: LineOrigin;
  sourceKey: string | null;
  /** The customer the service was delivered to, when another company in the group pays for it. */
  sourceOrganization: Ref | null;
  decision: LineDecision;
  conflict: LineConflict;
  sourceDescription: string | null;
  sourceQuantity: number | null;
  sourceUnitPrice?: number | null;
  sourceDiscountPct?: number | null;
  sourceLineTotal?: number | null;
  changeReason: string | null;
  changedBy: Ref | null;
  changedAt: string | null;
}

export interface ExportAttempt {
  at: string;
  result: string;
  message: string | null;
  correlationId: string | null;
}

export interface Invoice {
  id: string;
  system: string;
  invoiceNo: string;
  orderNo: string | null;
  organization: Ref | null;
  basisId: string | null;
  invoiceDate: string;
  dueDate: string | null;
  totalIncVat?: number;
  outstanding?: number;
  status: InvoiceStatus;
  isOverdue: boolean;
  url: string | null;
  syncedAt: string;
  movements: InvoiceMovement[];
}

export interface Basis {
  id: string;
  runId: string;
  periodStart: string;
  periodEnd: string;
  runStatus: RunStatus;
  organization: Ref;
  status: BasisStatus;
  totalExVat?: number;
  previousPeriodTotal?: number;
  anomalies: Anomaly[];
  customerReference: string | null;
  orderNo: string | null;
  exportedAt: string | null;
  /** A send got under way and its order may exist: the basis is reconciled before it is cancelled or sent again (ADR-013). */
  sendStarted: boolean;
  lines: BasisLine[];
  attempts: ExportAttempt[];
  invoices: Invoice[];
  revision: number;
  conflicts: number;
  etag: string;
}

export interface ReconcileRequest {
  created: boolean;
  orderNo: string | null;
  reason: string;
}

export interface CorrectionRequest {
  amount: number;
  reason: string;
  description: string | null;
}

/** A line billed before the charge register whose source the backfill could not prove; Finance decides (EXT-01). */
export interface LegacyCharge {
  id: string;
  organization: Ref;
  periodStart: string | null;
  description: string | null;
  amount?: number;
  reason: string | null;
  etag: string;
}

export interface LegacyChargeReport {
  count: number;
  amount?: number;
  byReason: Array<{ reason: string; count: number; amount?: number }>;
  items: LegacyCharge[];
}

/** Totals of every invoice the filter matches (overdue as of `asOf`), and one page of them (DEV-12). */
export interface InvoiceSummary {
  count: number;
  outstanding?: number;
  overdue?: number;
  invoices: Invoice[];
  nextCursor: string | null;
  asOf: string;
}

export interface BillingSettings {
  secondApprovalThreshold: number;
  totalChangeAnomalyPct: number;
  detailedHourLines: boolean;
}

export interface ManualLineRequest {
  productId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPct: number | null;
  vatRate: number | null;
  reason?: string | null;
}

/** `reason` is required when the line came from a source. */
export interface AdjustLineRequest {
  quantity: number;
  unitPrice: number;
  discountPct: number;
  description: string;
  reason: string | null;
}
