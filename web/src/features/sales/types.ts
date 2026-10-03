export const leadStatuses = ['New', 'Qualified', 'Disqualified', 'Converted'] as const;
export type LeadStatus = (typeof leadStatuses)[number];
export const businessLines = ['Microsoft', 'Msp', 'PowerOffice', 'Mixed'] as const;
export type BusinessLine = (typeof businessLines)[number];
export const opportunityStatuses = ['Open', 'Won', 'Lost'] as const;
export type OpportunityStatus = (typeof opportunityStatuses)[number];

export interface Ref {
  id: string;
  name: string;
}

export interface Stage {
  id: string;
  name: string;
  probability: number;
  order: number;
  isWon: boolean;
  isLost: boolean;
  isActive: boolean;
  openOpportunities: number;
  etag: string;
}

export interface Lead {
  id: string;
  companyName: string;
  orgNumber: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: LeadStatus;
  owner: Ref | null;
  notes: string | null;
  disqualifyReason: string | null;
  organizationId: string | null;
  opportunityId: string | null;
  createdAt: string;
  etag: string;
}

export interface LeadRequest {
  companyName: string;
  orgNumber: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  ownerId: string | null;
  notes: string | null;
}

export interface Opportunity {
  id: string;
  organization: Ref;
  contactId: string | null;
  contactName: string | null;
  name: string;
  businessLine: BusinessLine;
  stageId: string;
  stageName: string;
  probability: number;
  expectedCloseDate: string;
  /** Money is only present for users with finance.read. */
  oneOffAmount?: number;
  mrr?: number;
  termMonths: number;
  forecastAmount?: number;
  owner: Ref | null;
  source: string | null;
  competitor: string | null;
  status: OpportunityStatus;
  lostReason: string | null;
  closedOn: string | null;
  lastActivityAt: string;
  isStale: boolean;
  etag: string;
}

export interface OpportunityRequest {
  organizationId: string;
  contactId: string | null;
  name: string;
  businessLine: BusinessLine;
  stageId: string;
  probability: number | null;
  expectedCloseDate: string;
  oneOffAmount: number;
  mrr: number;
  termMonths: number;
  ownerId: string | null;
  source: string | null;
  competitor: string | null;
}

export interface PipelineColumn {
  stageId: string;
  stageName: string;
  probability: number;
  count: number;
  forecast?: number;
  opportunities: Opportunity[];
}

export interface ForecastMonth {
  year: number;
  month: number;
  count: number;
  weighted?: number;
  total?: number;
}

export interface PipelineView {
  columns: PipelineColumn[];
  forecast: ForecastMonth[];
  stale: number;
}
