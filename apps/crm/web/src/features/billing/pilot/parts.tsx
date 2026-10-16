import type { ReactNode } from 'react';
import { Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import type { CompareStatus } from './api';
import { usePilotStyles } from './styles';

const verdictClass: Record<CompareStatus, 'good' | 'warn' | 'bad'> = {
  Matched: 'good',
  Different: 'warn',
  MissingInCrm: 'bad',
  MissingInFile: 'warn',
  MissingCustomer: 'bad',
  Rejected: 'bad',
};

/** A verdict as plain text with a palette foreground (tinted badges fail the dark-theme contrast check). */
export function Verdict({ status }: { status: string }) {
  const styles = usePilotStyles();
  const { t } = useTranslation();
  const cls = verdictClass[status as CompareStatus];
  return <Text className={cls ? styles[cls] : styles.neutral}>{t(`pilot.verdict.${status}`, { defaultValue: status })}</Text>;
}

/** A scroll region a keyboard user can reach and scroll, named for assistive technology. */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  const styles = usePilotStyles();
  return (
    <div className={styles.scroll} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

