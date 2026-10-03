import { parseDecimal } from '../../shared/utils/format';
import type { QuoteLine, QuoteLineRecurrence } from './types';

/** A line while it is being edited: amounts stay strings so a half-typed number is not thrown away. */
export interface LineDraft {
  key: string;
  product: { id: string; sku: string; name: string } | null;
  productId: string | null;
  sku: string | null;
  name: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPct: string;
  recurrence: QuoteLineRecurrence;
  vatRate: number | null;
}

export function emptyLine(): LineDraft {
  return {
    key: crypto.randomUUID(),
    product: null,
    productId: null,
    sku: null,
    name: '',
    description: '',
    quantity: '1',
    unitPrice: '',
    discountPct: '0',
    recurrence: 'Monthly',
    vatRate: null,
  };
}

export function toDraft(line: QuoteLine): LineDraft {
  return {
    key: line.id,
    product: line.productId ? { id: line.productId, sku: line.sku ?? '', name: line.name } : null,
    productId: line.productId,
    sku: line.sku,
    name: line.name,
    description: line.description ?? '',
    quantity: String(line.quantity),
    unitPrice: line.unitPrice === undefined ? '' : String(line.unitPrice),
    discountPct: String(line.discountPct),
    recurrence: line.recurrence,
    vatRate: line.vatRate,
  };
}

export function lineAmount(line: LineDraft): number {
  const quantity = parseDecimal(line.quantity) ?? 0;
  const price = parseDecimal(line.unitPrice) ?? 0;
  const discount = parseDecimal(line.discountPct) ?? 0;
  return Number.isFinite(quantity * price) ? Math.round(quantity * price * (100 - discount)) / 100 : 0;
}

