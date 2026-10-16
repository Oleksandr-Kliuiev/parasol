import type { PagedResult } from '../../api/types';

export const productTypes = ['MicrosoftLicense', 'ManagedService', 'HourlyService', 'HourBank', 'PowerOfficeService', 'Hardware', 'Bundle'] as const;
export type ProductType = (typeof productTypes)[number];
export const businessLines = ['Microsoft', 'Atera', 'PowerOffice', 'Consulting', 'Hardware', 'Other'] as const;
export type BusinessLine = (typeof businessLines)[number];
export const productUnits = ['Piece', 'User', 'Device', 'License', 'Hour', 'Month', 'Package'] as const;
export type ProductUnit = (typeof productUnits)[number];
export const billingPeriods = ['OneTime', 'Monthly', 'Quarterly', 'Yearly'] as const;
export type BillingPeriod = (typeof billingPeriods)[number];
export const commitmentTerms = ['None', 'P1M', 'P1Y', 'P3Y'] as const;
export type CommitmentTerm = (typeof commitmentTerms)[number];
export const vatRates = [25, 15, 12, 0] as const;

export interface BundleComponent {
  productId: string;
  quantity: number;
  sku?: string | null;
  name?: string | null;
}

export interface ProductListItem {
  id: string;
  sku: string;
  name: string;
  type: ProductType;
  businessLine: BusinessLine;
  unit: ProductUnit;
  billingPeriod: BillingPeriod;
  listPrice: number;
  /** Only present for users with finance.cost.read. */
  unitCost?: number | null;
  currency: string;
  isActive: boolean;
}

export interface Product extends Omit<ProductListItem, 'unitCost'> {
  nameEn: string | null;
  description: string | null;
  vatRate: number;
  unitCost?: number | null;
  marginPct?: number | null;
  microsoftOfferId: string | null;
  commitmentTerm: CommitmentTerm;
  ateraWorkType: string | null;
  revenueAccount: string | null;
  components: BundleComponent[];
  createdAt: string;
  modifiedAt: string | null;
}

export interface ProductRequest {
  sku: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  type: ProductType;
  businessLine: BusinessLine;
  unit: ProductUnit;
  billingPeriod: BillingPeriod;
  vatRate: number;
  listPrice: number;
  unitCost: number | null;
  currency: string;
  microsoftOfferId: string | null;
  commitmentTerm: CommitmentTerm;
  ateraWorkType: string | null;
  revenueAccount: string | null;
  components: Array<{ productId: string; quantity: number }>;
}

export type ProductPage = PagedResult<ProductListItem>;

export interface CustomerCategory {
  id: string;
  code: string;
  name: string;
  licenseMarkupPct: number;
  isDefault: boolean;
  etag: string;
}

export type PriceListStatus = 'Draft' | 'Active';

export interface PriceListSummary {
  id: string;
  name: string;
  customerCategory: string;
  validFrom: string;
  validTo: string | null;
  currency: string;
  status: PriceListStatus;
  items: number;
  isCurrent: boolean;
}

export interface PriceListItem {
  productId: string;
  sku: string;
  productName: string;
  productType: ProductType;
  unit: ProductUnit;
  listPrice: number;
  unitPrice: number;
  unitCost?: number | null;
  marginPct?: number | null;
  partnerPrice?: number | null;
  partnerCurrency?: string | null;
  exchangeRate?: number | null;
}

export interface PriceList {
  id: string;
  name: string;
  customerCategory: string;
  validFrom: string;
  validTo: string | null;
  currency: string;
  status: PriceListStatus;
  items: PriceListItem[];
  createdAt: string;
  modifiedAt: string | null;
}

export interface PriceListRequest {
  name: string;
  customerCategory: string;
  validFrom: string;
  validTo: string | null;
  currency: string | null;
}

export interface PriceItemRequest {
  unitPrice: number | null;
  unitCost: number | null;
  partnerPrice: number | null;
  partnerCurrency: string | null;
  exchangeRate: number | null;
}

/** One product's new price when the Microsoft price sheet is applied (FR-CAT-03). */
export interface PriceSheetImportRow {
  productId: string;
  productName: string;
  offerId: string;
  partnerPrice: number;
  partnerCurrency: string;
  unitPrice: number;
  previousUnitPrice: number | null;
  changed: boolean;
}

export interface PriceSheetImportResult {
  matched: number;
  changed: number;
  unchanged: number;
  withoutProduct: number;
  exchangeRate: number;
  markupPct: number;
  rows: PriceSheetImportRow[];
  warnings: string[];
}
