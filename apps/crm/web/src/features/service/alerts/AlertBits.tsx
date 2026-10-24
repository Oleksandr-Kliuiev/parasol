import { Fragment, type ReactNode } from 'react';
import { Badge, Link, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { formatDateTime, formatRelative } from '../../../shared/utils/format';
import type { AlertSeverity } from '../types';
import { sourceName } from './alertText';

const useStyles = makeStyles({
  badge: { flexShrink: 0 },
  facts: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' },
  // A short fact stays on one line ("Source: Atera", "3 hours ago"); only names and device names may break.
  keep: { whiteSpace: 'nowrap' },
  // The link tone of every other link (My day's urgent rows), at rest as on hover; a 24 px hit box (WCAG 2.5.8) that wraps like text.
  title: {
    display: 'inline-flex', alignItems: 'center', minHeight: '24px', maxWidth: '100%', textAlign: 'start', fontSize: '14px', lineHeight: '20px',
    overflowWrap: 'anywhere',
  },
});

/**
 * An alert's title, which opens its side panel (the queue and the Drift tab): it looks like the link it is, as the urgent rows of
 * My day do. Fluent's restore target gives focus back to it when the panel closes, also after Back closed it.
 */
export function AlertTitle({ title, onOpen }: { title: string; onOpen: () => void }) {
  const styles = useStyles(); const restore = useRestoreFocusTarget();
  return <Link {...restore} as="button" className={styles.title} onClick={onOpen}>{title}</Link>;
}

/**
 * The facts of an alert row in one muted line. The dot is bound to the fact before it, so a line that wraps ends with a dot and
 * never starts with one.
 */
export function AlertFacts({ parts }: { parts: ReactNode[] }) {
  const styles = useStyles();
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== '');
  return <span className={styles.facts}>{shown.map((part, index) => <Fragment key={index}>{index > 0 && ' · '}{part}</Fragment>)}</span>;
}

/** The severity as a badge that carries its word: the colour is never the only sign (WCAG 1.4.1). */
export function AlertSeverityBadge({ severity }: { severity: AlertSeverity }) {
  const { t } = useTranslation(); const styles = useStyles();
  return <Badge appearance="tint" className={styles.badge} color={severity === 'Critical' ? 'danger' : 'warning'}>{t(`service.severities.${severity}`)}</Badge>;
}

/** An age in a list: relative, with the exact moment for a pointer and for assistive technology. */
export function AlertAge({ at }: { at: string }) {
  const styles = useStyles();
  return <time className={styles.keep} dateTime={at} title={formatDateTime(at)}>{formatRelative(at)}</time>;
}

/** Where the alert comes from, as a source label: vendor names appear only here ("Source: Atera"). */
export function AlertSource({ system }: { system: string }) {
  const { t } = useTranslation(); const styles = useStyles();
  return <span className={styles.keep}>{t('alerts.source', { name: sourceName(t, system) })}</span>;
}
