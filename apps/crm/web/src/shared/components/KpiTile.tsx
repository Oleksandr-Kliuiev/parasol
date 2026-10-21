import { useRef, type ReactElement, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowUpRight16Regular } from '@fluentui/react-icons';
import { h, tone as tones, type Tone } from '../../app/hearth';
import { ease, useReveal } from '../../app/motion';
import { countable } from './countable';

const useStyles = makeStyles({
  // Tiles of a row share their two rows (subgrid): footers line up, and so do the values above them.
  tile: {
    display: 'grid',
    gridRow: 'span 2',
    gridTemplateRows: 'subgrid',
    rowGap: 0,
    minWidth: 0,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    borderRadius: '20px',
    boxShadow: tokens.shadow4,
    color: 'inherit',
    textDecorationLine: 'none',
  },
  // A tile that opens a list lifts towards the pointer, as the cards of the reference do.
  link: {
    transitionProperty: 'box-shadow, translate',
    transitionDuration: '0.45s',
    transitionTimingFunction: ease.out,
    ':hover': { boxShadow: tokens.shadow8, translate: '0 -4px' },
    '&:hover .kpi-go': { color: h.text, backgroundColor: h.well },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  // The value keeps to the foot of the body, so values line up across a row with one- and two-line labels.
  body: { display: 'grid', gridTemplateRows: 'auto auto 1fr', alignContent: 'start', gap: '10px', paddingTop: '16px', paddingInline: '18px', paddingBottom: '14px' },
  top: { display: 'flex', alignItems: 'center', gap: '10px' },
  icon: {
    display: 'grid',
    placeItems: 'center',
    boxSizing: 'border-box',
    width: '38px',
    height: '38px',
    borderRadius: '12px',
    border: `1px solid ${h.line}`,
    backgroundColor: tokens.colorNeutralBackground3,
    '& svg': { width: '18px', height: '18px' },
  },
  go: { display: 'grid', placeItems: 'center', width: '30px', height: '30px', marginLeft: 'auto', borderRadius: '10px', color: h.faint },
  label: { color: h.muted, fontSize: '13px', fontWeight: 600, lineHeight: '18px' },
  value: {
    alignSelf: 'end',
    fontFamily: h.display,
    fontSize: 'clamp(22px, 1.9vw, 28px)',
    lineHeight: 1.05,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
    // A long amount ("NOK 184 250,00") wraps instead of being cut off in the two-column phone row.
    overflowWrap: 'anywhere',
    '@media (max-width: 560px)': { fontSize: '20px' },
  },
  foot: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px 10px',
    paddingBlock: '10px',
    paddingInline: '18px',
    borderTop: `1px solid ${h.line}`,
    backgroundColor: tokens.colorNeutralBackground3,
    color: h.muted,
    fontSize: '12.5px',
    lineHeight: '18px',
    '& b': { color: h.text, fontVariantNumeric: 'tabular-nums' },
  },
});

interface KpiTileProps {
  icon: ReactElement;
  tone?: Tone;
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  /** The tile opens the list behind the number. */
  to?: string;
}

/** A key figure of the visual system: icon, label, number and a footer line with its context. */
export function KpiTile({ icon, tone = 'ember', label, value, foot, to }: KpiTileProps) {
  const styles = useStyles();
  const ref = useRef<HTMLElement>(null);
  useReveal(ref, 'tile');
  const content = (
    <>
      <div className={styles.body}>
        <div className={styles.top}>
          <span className={styles.icon} style={{ color: tones[tone].text }} aria-hidden>
            {icon}
          </span>
          {to && (
            <span className={mergeClasses(styles.go, 'kpi-go')} aria-hidden>
              <ArrowUpRight16Regular />
            </span>
          )}
        </div>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{countable(value)}</span>
      </div>
      {foot && <div className={styles.foot}>{foot}</div>}
    </>
  );
  return to ? (
    <Link ref={ref as RefObject<HTMLAnchorElement>} to={to} className={mergeClasses(styles.tile, styles.link)}>
      {content}
    </Link>
  ) : (
    <div ref={ref as RefObject<HTMLDivElement>} className={styles.tile}>{content}</div>
  );
}

const useRowStyles = makeStyles({
  row: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    gap: '16px',
    marginBottom: '16px',
    '@media (max-width: 1100px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    '@media (max-width: 560px)': { gap: '10px' },
  },
});

/** Four tiles in a row on desktop, two on tablets and phones. */
export function KpiRow({ children, label }: { children: ReactNode; label: string }) {
  const styles = useRowStyles();
  return (
    <section className={styles.row} aria-label={label}>
      {children}
    </section>
  );
}

const useStatStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(min(200px, 100%), 1fr))',
    gap: '16px',
    marginBottom: '16px',
    '@media (max-width: 560px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' },
  },
  // Label, value and note rows are shared by the tiles of a row (subgrid), so a two-line label or a missing note never
  // moves one value off the line of the others.
  tile: {
    display: 'grid',
    gridRow: 'span 3',
    gridTemplateRows: 'subgrid',
    alignContent: 'start',
    rowGap: '6px',
    minWidth: 0,
    paddingTop: '14px',
    paddingBottom: '14px',
    paddingLeft: '16px',
    paddingRight: '16px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    borderRadius: '16px',
    boxShadow: tokens.shadow4,
  },
  top: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
  // The arrow of the KPI tiles: a tile that opens something says so before the pointer finds it (touch has no hover).
  go: { display: 'grid', placeItems: 'center', flexShrink: 0, width: '24px', height: '24px', marginLeft: 'auto', borderRadius: '8px', color: h.faint },
  icon: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    boxSizing: 'border-box',
    width: '32px',
    height: '32px',
    borderRadius: '10px',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${h.line}`,
    '& svg': { width: '16px', height: '16px' },
    // Two tiles share a phone's row: the label needs the room more than the decoration does.
    '@media (max-width: 560px)': { display: 'none' },
  },
  // A tile that opens something is a link, and links in main may break anywhere (long names): a label breaks between
  // words, or by the language's hyphenation, never letter by letter ("Agr/eem/ent" at 320 px).
  label: { color: h.muted, fontSize: '13px', fontWeight: 600, lineHeight: '18px', minWidth: 0, overflowWrap: 'normal', hyphens: 'auto' },
  value: {
    fontFamily: h.display,
    fontSize: 'clamp(20px, 1.7vw, 24px)',
    lineHeight: 1.1,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    fontVariantNumeric: 'tabular-nums',
    overflowWrap: 'anywhere',
  },
  note: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  bad: { color: h.emberT },
  good: { color: h.spruceT },
  // A tile that opens the records behind its figure lifts like the KPI tiles do.
  link: {
    color: 'inherit',
    textDecorationLine: 'none',
    transitionProperty: 'box-shadow, translate',
    transitionDuration: '0.45s',
    transitionTimingFunction: ease.out,
    ':hover': { boxShadow: tokens.shadow8, translate: '0 -3px', color: 'inherit', textDecorationLine: 'none' },
    '&:hover .stat-go': { color: h.text, backgroundColor: h.well },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
});

/** Tiles for a page's own key figures (invoices, licences, margins...): one grid, one tile look across the app. */
export function StatGrid({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  const styles = useStatStyles();
  return (
    <div className={mergeClasses(styles.grid, className)} role={label ? 'group' : undefined} aria-label={label}>
      {children}
    </div>
  );
}

interface StatTileProps {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  icon?: ReactElement;
  tone?: Tone;
  /** Colours the value: "bad" for money overdue or a missed target, "good" for a margin above zero. */
  status?: 'bad' | 'good';
  className?: string;
  /** The tile opens the records behind its figure. */
  to?: string;
  /** For a link within the page (a tab): replace the history entry and pass state to the page, as its own control would. */
  replace?: boolean;
  state?: unknown;
}

export function StatTile({ label, value, note, icon, tone = 'neutral', status, className, to, replace, state }: StatTileProps) {
  const styles = useStatStyles();
  const ref = useRef<HTMLElement>(null);
  useReveal(ref, 'tile');
  const content = (
    <>
      <div className={styles.top}>
        {icon && (
          <span className={styles.icon} style={{ color: tones[tone].text }} aria-hidden>
            {icon}
          </span>
        )}
        <span className={styles.label}>{label}</span>
        {to && (
          <span className={mergeClasses(styles.go, 'stat-go')} aria-hidden>
            <ArrowUpRight16Regular />
          </span>
        )}
      </div>
      <span className={mergeClasses(styles.value, status && styles[status])}>{countable(value)}</span>
      {note && <span className={styles.note}>{note}</span>}
    </>
  );
  return to ? (
    <Link ref={ref as RefObject<HTMLAnchorElement>} to={to} replace={replace} state={state} className={mergeClasses(styles.tile, styles.link, className)}>
      {content}
    </Link>
  ) : (
    <div ref={ref as RefObject<HTMLDivElement>} className={mergeClasses(styles.tile, className)}>{content}</div>
  );
}
