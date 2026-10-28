import { useEffect, useRef, type ReactNode } from 'react';
import { Button, Link, Spinner, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Dismiss16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import type { MatchingSelection } from './alertBulk';

const useStyles = makeStyles({
  // Above the list and, on a wide screen, held below the top bar while the person goes down the rows ticking them; the page keeps
  // focused rows clear of it (styles.css, data-alert-bulk-bar). On a phone it stays in place: wrapped, it would cover the rows.
  // It is there while rows can be chosen, chosen or not, so ticking the first one moves no row under the pointer.
  bar: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '12px', rowGap: '8px', minHeight: '48px', boxSizing: 'border-box',
    marginBottom: '12px', paddingTop: '8px', paddingBottom: '8px', paddingLeft: '14px', paddingRight: '8px', borderRadius: '14px',
    border: `1px solid ${h.line2}`, backgroundColor: h.surface,
    '@media (min-width: 768px)': { position: 'sticky', top: '80px', zIndex: 5 },
  },
  // Lifted only while something is chosen: then it is what the person works with.
  active: { boxShadow: tokens.shadow8 },
  count: { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '10px', rowGap: '4px', minHeight: '32px',
    fontVariantNumeric: 'tabular-nums' },
  idle: { color: h.muted, fontWeight: 500 },
  // A 24 px hit box for the way to every match (WCAG 2.5.8).
  more: { minHeight: '24px', fontWeight: 600, textAlign: 'start' },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginLeft: 'auto' },
});

/**
 * The chosen alerts and what can be done with them (M45): how many are chosen, the way from the rows shown to "all that match"
 * (with how many that is, and the limit of one bulk action), the bulk actions and the way out. The count is announced as it changes;
 * with nothing chosen yet the bar says what it is for and offers "all that match" at once. More chosen than one bulk action takes
 * (every row of several pages, or one more ticked beside "all that match") offers no action, only what to do instead.
 */
export function AlertBulkBar({ count, shown, total, matching, limit, selecting, actions, onSelectMatching, onClear }: {
  count: number;
  /** The rows on screen. */
  shown: number;
  /** How many alerts the filters match, from the newest answer; null while it is read. */
  total: number | null;
  matching: MatchingSelection | null;
  limit: number;
  /** "All that match" is being read. */
  selecting: boolean;
  actions: ReactNode;
  onSelectMatching: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation(); const styles = useStyles();
  const link = useRef<HTMLButtonElement>(null); const tools = useRef<HTMLSpanElement>(null);
  // "All that match" replaces the link that asked for it: focus goes on to the first thing that can be done with them, never to the page.
  const handOn = useRef(false);
  useEffect(() => {
    if (matching && handOn.current) tools.current?.querySelector<HTMLElement>('button')?.focus();
    if (!selecting) handOn.current = false;
  }, [matching, selecting]);
  // Nothing chosen, or every row on screen and more match: the way to all of them, as many as one bulk action takes.
  const offerMatching = matching === null && total !== null && total > shown && (count === 0 || count === shown);
  const over = count > limit;
  const said = count === 0 ? t('alerts.bulk.idle')
    : over ? t('alerts.bulk.overLimit', { chosen: count, limit })
      : matching ? matching.total > count ? t('alerts.bulk.matchingCut', { count, total: matching.total }) : t('alerts.bulk.matchingAll', { count })
        : t('alerts.bulk.selected', { count });
  return <div data-alert-bulk-bar role="region" aria-label={t('alerts.bulk.label')} className={mergeClasses(styles.bar, count > 0 && styles.active)}>
    <span className={styles.count}>
      <Text role="status" weight={count > 0 ? 'semibold' : undefined} className={count > 0 ? undefined : styles.idle}>{said}</Text>
      {offerMatching && <>
        <Link ref={link} as="button" type="button" className={styles.more} aria-disabled={selecting || undefined} onClick={() => {
          if (selecting) return;
          handOn.current = document.activeElement === link.current;
          onSelectMatching();
        }}>{total > limit ? t('alerts.bulk.selectFirst', { count: limit, total }) : t('alerts.bulk.selectMatching', { count: total })}</Link>
        {selecting && <Spinner size="extra-tiny" label={t('alerts.bulk.selecting')} />}
      </>}
    </span>
    {count > 0 && <span ref={tools} className={styles.actions}>
      {!over && actions}
      <Button appearance="subtle" icon={<Dismiss16Regular />} onClick={onClear}>{t('alerts.bulk.clear')}</Button>
    </span>}
  </div>;
}
