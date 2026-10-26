import { useId, useRef, type ReactElement, type ReactNode, type Ref } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { h } from '../../app/hearth';
import { CompactControls } from '../../app/compactControls';
import { useReveal } from '../../app/motion';
import { countable } from './countable';

const useStyles = makeStyles({
  // The card of the visual system: 20 px corners, a hairline and a long soft shadow.
  panel: {
    position: 'relative',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: '20px',
    border: `1px solid ${h.line}`,
    paddingTop: '18px',
    paddingLeft: '20px',
    paddingRight: '20px',
    paddingBottom: '20px',
    boxShadow: tokens.shadow4,
    minWidth: 0,
    '@media (max-width: 600px)': { paddingTop: '16px', paddingLeft: '16px', paddingRight: '16px', paddingBottom: '16px' },
  },
  header: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    columnGap: '12px',
    rowGap: tokens.spacingVerticalS,
    minHeight: '36px',
    marginBottom: '14px',
  },
  // Header actions are quiet: small buttons and links, the page keeps the one primary action.
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    maxWidth: '100%',
    minWidth: 0,
  },
  heading: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: 0,
    fontFamily: h.display,
    fontSize: '16px',
    lineHeight: '22px',
    fontWeight: 600,
    letterSpacing: '-0.01em',
    flexShrink: 0,
    maxWidth: '100%',
    overflowWrap: 'anywhere',
  },
  icon: { display: 'inline-flex', color: h.faint, '& svg': { width: '16px', height: '16px' } },
  // Longhands and its own phone rule, so the panel's phone padding never wins over flush.
  flush: {
    paddingLeft: 0,
    paddingRight: 0,
    paddingBottom: 0,
    overflow: 'hidden',
    '@media (max-width: 600px)': { paddingLeft: 0, paddingRight: 0, paddingBottom: 0 },
  },
  flushHeader: { paddingLeft: '20px', paddingRight: '20px', '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' } },
  list: {
    display: 'grid',
    gridTemplateColumns: 'minmax(120px, max-content) 1fr',
    columnGap: tokens.spacingHorizontalL,
    rowGap: '10px',
    margin: 0,
  },
  term: { color: h.muted, fontSize: '13px' },
  value: { margin: 0, overflowWrap: 'anywhere', fontSize: '14px', fontWeight: 600 },
  // An empty value is a quiet dash: the field exists, nothing is recorded.
  none: { color: h.faint, fontWeight: 500 },
  // Key figures as small tiles (the "funded / projected / days left" row of the reference).
  facts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(150px, 100%), 1fr))',
    gap: '10px',
    margin: 0,
  },
  // The value sits at the foot of the tile, so values line up across a row whose labels take one or two lines.
  fact: { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '4px', padding: '10px 12px', borderRadius: '12px', backgroundColor: tokens.colorNeutralBackground3 },
  // A figure that asks for a look (unread customers, mapping issues) carries the saffron tone of a warning.
  factWarn: { backgroundColor: h.saffronSoft, '& dt': { color: h.saffronT }, '& dd': { color: h.saffronT } },
  factTerm: { color: h.muted, fontSize: '12px', fontWeight: 600, lineHeight: '16px' },
  factValue: { margin: 0, fontFamily: h.display, fontSize: '18px', lineHeight: '24px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
});

interface PanelProps {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  /** A 16 px icon before the title. */
  icon?: ReactElement;
  /** Content runs to the card edges (tables, lists with their own padding). */
  flush?: boolean;
  className?: string;
  /** For a page that moves focus to the card after its actions are gone (a bulk action that cleared its selection). */
  headingRef?: Ref<HTMLHeadingElement>;
}

/** A titled section; the title names the region, so screen reader users can jump between panels. */
export function Panel({ title, children, actions, icon, flush, className, headingRef }: PanelProps) {
  const styles = useStyles();
  const headingId = useId();
  const ref = useRef<HTMLElement>(null);
  useReveal(ref, 'card');
  return (
    <section ref={ref} className={mergeClasses(styles.panel, flush && styles.flush, className)} aria-labelledby={title ? headingId : undefined}>
      {(title || actions) && (
        <div className={mergeClasses(styles.header, flush && styles.flushHeader)}>
          {title && (
            <h2 id={headingId} ref={headingRef} tabIndex={headingRef ? -1 : undefined} className={styles.heading}>
              {icon && <span className={styles.icon} aria-hidden>{icon}</span>}
              {title}
            </h2>
          )}
          {actions && <div className={styles.actions}><CompactControls.Provider value>{actions}</CompactControls.Provider></div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function DetailList({ items, className }: { items: Array<{ label: string; value: ReactNode }>; className?: string }) {
  const styles = useStyles();
  return (
    <dl className={mergeClasses(styles.list, className)}>
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt className={styles.term}>{item.label}</dt>
          <dd className={styles.value}>{item.value || <span className={styles.none}>—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The same terms and values as DetailList, shown as tiles: for a handful of counts that are read at a glance. */
export function FactGrid({ items, className }: { items: Array<{ label: string; value: ReactNode; warn?: boolean }>; className?: string }) {
  const styles = useStyles();
  return (
    <dl className={mergeClasses(styles.facts, className)}>
      {items.map((item) => (
        <div key={item.label} className={mergeClasses(styles.fact, item.warn && styles.factWarn)}>
          <dt className={styles.factTerm}>{item.label}</dt>
          <dd className={styles.factValue}>{countable(item.value || '—')}</dd>
        </div>
      ))}
    </dl>
  );
}
