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

export interface OrganizationDocuments {
  /** False when SharePoint is not configured; the tab then explains that instead of showing an empty list. */
  available: boolean;
  folder: DocumentFolder | null;
  items: DocumentItem[];
}
