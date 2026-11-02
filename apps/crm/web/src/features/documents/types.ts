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

/**
 * How reading the customer's folder ended (M47). Each is worded on the tab, so a folder that could not be read never looks absent:
 * no folder linked yet, read, gone from SharePoint (or out of the person's reach), no token for this sign-in, refused, no answer.
 */
export const documentFolderStates = ['NoFolder', 'Ready', 'Gone', 'NotConnected', 'NoAccess', 'Unavailable'] as const;
export type DocumentFolderState = (typeof documentFolderStates)[number];

export interface OrganizationDocuments {
  /** False when SharePoint is not configured; the tab then explains that instead of showing an empty list. */
  available: boolean;
  state: DocumentFolderState;
  /** The link to the folder, so a person may take a stale one off; null when the customer has none. */
  linkId: string | null;
  folder: DocumentFolder | null;
  /** The first page of the folder, folders first. */
  items: DocumentItem[];
  /** The folder holds more than the page: the tab says so and leads to SharePoint for the rest. */
  more: boolean;
}
