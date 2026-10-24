import { Fragment, useRef, type ReactNode } from 'react';
import { Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { useScrollEdges } from '../../../shared/utils/useScrollEdges';
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

/** A comparison key ("923456789|NOK|License") that may wrap after a separator, never inside a part. */
export function KeyText({ value }: { value: string }) {
  const parts = value.split('|');
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 && <>|<wbr /></>}
        </Fragment>
      ))}
    </>
  );
}

/** A scroll region a keyboard user can reach and scroll, named for assistive technology. */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  const styles = usePilotStyles();
  const { i18n } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // The edge that hides more columns fades, as in the app's other wide tables.
  const edges = useScrollEdges(ref, 'x', i18n.resolvedLanguage);
  return (
    <div ref={ref} className={styles.scroll} style={edges.style} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

