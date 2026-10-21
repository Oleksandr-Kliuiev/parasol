import { useTranslation } from 'react-i18next';
import { AlertReadLine } from './alerts/AlertReadLine';
import { sourceName } from './alerts/alertText';
import type { ServiceSourceRead } from './types';

/**
 * How fresh each kind of service data is (M39.2), said the way alerts say it: "Tickets (Atera) read at 15:05 · Devices (Atera) read
 * at 01:30", a read that did not finish or is overdue in the warning tone, "not read yet" before the first read.
 */
export function ServiceReadLine({ reads, className }: { reads: readonly ServiceSourceRead[]; className?: string }) {
  const { t } = useTranslation();
  return <AlertReadLine reads={reads} className={className} label={(read) => t(`service.reads.${read.source}`, { system: sourceName(t, read.system) })} />;
}
