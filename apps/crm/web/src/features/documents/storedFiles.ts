import { useState } from 'react';
import { download } from '../../api/client';
import i18n, { localeOf } from '../../i18n';
import { formatNumber } from '../../shared/utils/format';
import { storedDocumentUrl } from './api';

/** "september 2026": the month a stored report covers, in the interface language. */
export function reportMonth(periodStart: string): string {
  return new Intl.DateTimeFormat(localeOf(i18n.language), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${periodStart}T00:00:00Z`));
}

export function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${formatNumber(Math.max(1, Math.round(bytes / 1024)), 0)} KB` : `${formatNumber(bytes / (1024 * 1024), 1)} MB`;
}

/** One download at a time of the customer's stored reports (M43), with what is being fetched and whether the last one failed. */
export function useStoredDownload(organizationId: string) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const save = async (documentId: string) => {
    if (busy) return;
    setBusy(documentId);
    setFailed(false);
    try {
      await download(storedDocumentUrl(organizationId, documentId));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  return { busy, failed, save };
}
