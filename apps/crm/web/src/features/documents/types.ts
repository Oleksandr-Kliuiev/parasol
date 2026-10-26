export interface DocumentFolder {
  folderId: string;
  name: string;
  webUrl: string;
}

export interface DocumentItem {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  modifiedAt: string | null;
  modifiedBy: string | null;
  webUrl: string;
}

/** The kinds of monthly report the CRM files for a customer itself (M43). */
export const storedDocumentKinds = ['huntress-monthly', 'parasoll-monthly'] as const;
export type StoredDocumentKind = (typeof storedDocumentKinds)[number];

/**
 * A monthly report the CRM filed for the customer (M43), kept unchanged in Parasoll: Huntress's own PDF (`Source`) or Parasoll's
 * summary, taken while the month was at hand (`Captured`) or later (`Reconstructed`, which the PDF says on every page).
 */
export interface StoredDocument {
  id: string;
  kind: StoredDocumentKind;
  /** Where it comes from: `huntress:report:{id}` or `parasoll:summary:{yyyy-MM}`. */
  sourceKey: string;
  periodStart: string;
  periodEnd: string;
  fileName: string;
  length: number;
  provenance: 'Source' | 'Captured' | 'Reconstructed';
  storedAt: string;
}

export interface OrganizationDocuments {
  /** False when SharePoint is not configured; the tab then explains that instead of showing an empty list. */
  available: boolean;
  folder: DocumentFolder | null;
  items: DocumentItem[];
}
