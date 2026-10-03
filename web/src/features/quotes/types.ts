export const quoteStatuses = ['Draft', 'PendingApproval', 'Ready', 'Sent', 'Accepted', 'Declined', 'Expired', 'Superseded', 'Cancelled'] as const;
export type QuoteStatus = (typeof quoteStatuses)[number];

export const recurrences = ['Monthly', 'OneTime'] as const;
export type QuoteLineRecurrence = (typeof recurrences)[number];

export interface Ref {
  id: string;
  name: string;
}

export interface QuoteLine {
  id: string;
  productId: string | null;
  sku: string | null;
  name: string;
  description: string | null;
  quantity: number;
  /** Money is only present for users with finance.read. */
  unitPrice?: number;
  discountPct: number;
  recurrence: QuoteLineRecurrence;
  vatRate: number;
  netAmount?: number;
  sort: number;
}

export interface QuoteVersion {
  id: string;
  versionNo: number;
  status: QuoteStatus;
  issuedOn: string;
  sentAt: string | null;
}

export interface Quote {
  id: string;
  number: string;
  rootId: string;
  versionNo: number;
  organization: Ref;
  contactId: string | null;
  contactName: string | null;
  opportunityId: string | null;
  opportunityName: string | null;
  title: string;
  owner: Ref | null;
  language: string;
  issuedOn: string;
  validUntil: string;
  termMonths: number;
  introText: string | null;
  termsText: string | null;
  customerReference: string | null;
  status: QuoteStatus;
  maxDiscountPct: number;
  discountLimitPct: number;
  needsApproval: boolean;
  approvalRequestedBy: Ref | null;
  approvalRequestedAt: string | null;
  approvedBy: Ref | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  sentAt: string | null;
  sentTo: string | null;
  decidedOn: string | null;
  declineReason: string | null;
  isEditable: boolean;
  hasDocument: boolean;
  canSendByEmail: boolean;
  oneTimeExVat?: number;
  oneTimeVat?: number;
  monthlyExVat?: number;
  monthlyVat?: number;
  contractValue?: number;
  lines: QuoteLine[];
  versions: QuoteVersion[];
  etag: string;
}

export interface QuoteListItem {
  id: string;
  number: string;
  versionNo: number;
  organization: Ref;
  title: string;
  status: QuoteStatus;
  issuedOn: string;
  validUntil: string;
  owner: Ref | null;
  maxDiscountPct: number;
  monthlyExVat?: number;
  oneTimeExVat?: number;
  contractValue?: number;
  isLatestVersion: boolean;
  etag: string;
}

export interface QuoteLineRequest {
  productId: string | null;
  sku: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unitPrice: number | null;
  discountPct: number;
  recurrence: QuoteLineRecurrence;
  vatRate: number | null;
}

export interface QuoteRequest {
  organizationId: string;
  contactId: string | null;
  opportunityId: string | null;
  title: string;
  ownerId: string | null;
  language: string;
  validUntil: string | null;
  termMonths: number;
  templateId: string | null;
  introText: string | null;
  termsText: string | null;
  customerReference: string | null;
  lines: QuoteLineRequest[];
}

export interface QuoteTemplate {
  id: string;
  name: string;
  language: string;
  introText: string | null;
  termsText: string | null;
  footerText: string | null;
  validityDays: number;
  isDefault: boolean;
  isActive: boolean;
  etag: string;
}

export interface SendQuoteRequest {
  toAddress: string;
  toName: string | null;
  cc: string[];
  subject: string | null;
  message: string | null;
}

export interface OrganizationContact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  title: string | null;
  roles: string[];
  isPrimary: boolean;
  isActive: boolean;
}
