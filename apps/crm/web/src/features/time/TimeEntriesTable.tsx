import {
  Button,
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  mergeClasses,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { useCatalogStyles } from '../catalog/styles';
import { actionable, adjustable, classificationDot, statusDot } from './timeEntryState';
import type { TimeEntry } from './types';

const useStyles = makeStyles({
  // The table runs to the edges of its card: no second frame inside it.
  table: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: h.line,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
    borderRadius: 0,
    boxShadow: 'none',
    backgroundColor: 'transparent',
  },
  // Fixed columns for the checkbox, the date, the customer, the figures and the action; the work takes the rest.
  grid: {
    minWidth: '880px',
    // Column widths include the cell padding, so the fixed columns add up to what they say.
    '& th': { boxSizing: 'border-box' },
    '& td': { paddingTop: '10px', paddingBottom: '10px' },
    '& th:first-child, & td:first-child': { paddingLeft: '20px' },
    '& th:last-child, & td:last-child': { paddingRight: '20px' },
  },
  checkColumn: { width: '56px' },
  dateColumn: { width: '104px' },
  customerColumn: { width: '21%' },
  hoursColumn: { width: '72px' },
  billingColumn: { width: '164px' },
  amountColumn: { width: '128px' },
  actionColumn: { width: '104px' },
  // The customer and, under it, who did the work (the reference's name + sub line cell).
  stackCell: { display: 'grid', gap: '2px', minWidth: 0 },
  org: { fontWeight: 600, overflowWrap: 'anywhere' },
  // The reference's "loan type" cell: a coloured dot and the word, one part of the entry per line.
  parts: { display: 'grid', gap: '4px', justifyItems: 'start' },
  part: { display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap' },
  dot: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0 },
  meta: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  review: { color: h.emberT, fontSize: '12.5px', lineHeight: '18px' },
  link: { fontSize: '12.5px', lineHeight: '18px' },
  // Phones: one row per entry instead of a table that would hide most of its columns.
  list: { listStyleType: 'none', margin: 0, padding: 0, borderTop: `1px solid ${h.line}` },
  selectAll: { display: 'flex', alignItems: 'center', minHeight: '44px', paddingLeft: '8px', paddingRight: '16px', borderBottom: `1px solid ${h.line}` },
  card: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    columnGap: '4px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '16px',
    paddingRight: '16px',
    borderTop: `1px solid ${h.line}`,
    ':first-child': { borderTop: 'none' },
  },
  withCheck: { gridTemplateColumns: '36px minmax(0, 1fr)', paddingLeft: '8px' },
  check: { alignSelf: 'start', marginTop: '-6px' },
  cardBody: { display: 'grid', gap: '6px', minWidth: 0 },
  cardTop: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: '12px', rowGap: '2px' },
  when: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', fontVariantNumeric: 'tabular-nums' },
  figures: { fontFamily: h.display, fontSize: '15px', lineHeight: '20px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  cardEnd: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
});

interface TimeEntriesTableProps {
  entries: TimeEntry[];
  /** Selection is offered only while some entry of the list can still be approved or withdrawn. */
  selectable: boolean;
  canManage: boolean;
  canReview: boolean;
  canSeeMoney: boolean;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onAdjust: (entry: TimeEntry) => void;
}

/** What approval made of an entry: its status, or the parts it was split into (covered, hour bank, rate). */
function BillingParts({ entry }: { entry: TimeEntry }) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <span className={styles.parts}>
      {entry.status === 'New' || entry.allocations.length === 0 ? (
        <span className={styles.part}>
          <span className={styles.dot} style={{ backgroundColor: statusDot[entry.status] }} aria-hidden />
          <span>{t(`time.statuses.${entry.status}`)}</span>
        </span>
      ) : (
        entry.allocations.map((allocation, index) => (
          <span key={index} className={styles.part}>
            <span className={styles.dot} style={{ backgroundColor: classificationDot[allocation.classification] }} aria-hidden />
            <span>{t(`time.classifications.${allocation.classification}`)} {formatNumber(allocation.hours)} {t('contracts.hoursShort')}</span>
          </span>
        ))
      )}
    </span>
  );
}

/** The work: what was done, its type and ticket, a saved review note and, for Finance, the way to the review. */
function WorkCell({ entry, canReview }: { entry: TimeEntry; canReview: boolean }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const meta = [entry.workType, entry.externalTicketId ? `#${entry.externalTicketId}` : null, entry.source === 'Atera' ? 'Atera' : null].filter(Boolean).join(' · ');
  return (
    <span className={styles.stackCell}>
      {(entry.description ?? entry.ticketTitle) && <span>{entry.description ?? entry.ticketTitle}</span>}
      {meta && <span className={styles.meta}>{meta}</span>}
      {entry.reviewNote && <span className={styles.review}>{entry.reviewNote}</span>}
      {canReview && (
        <span>
          <AppLink to={`/time/entries/${entry.id}/financial-review`} appearance="subtle" className={styles.link}>{t('financialReview.open')}</AppLink>
        </span>
      )}
    </span>
  );
}

/** The entries of the month with what approval made of them: a table on wide screens, a list of rows on phones. */
export function TimeEntriesTable(props: TimeEntriesTableProps) {
  const narrow = useMediaQuery(NARROW_SCREEN);
  return narrow ? <TimeEntryRows {...props} /> : <EntriesTable {...props} />;
}

function EntriesTable({ entries, selectable, canManage, canReview, canSeeMoney, selected, onSelect, onAdjust }: TimeEntriesTableProps) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const restoreFocusTarget = useRestoreFocusTarget();
  const approvable = entries.filter(adjustable).map((e) => e.id);
  const withAdjust = canManage && entries.some(adjustable);

  return (
    <ScrollTable className={styles.table}>
      <Table className={styles.grid} aria-label={t('time.title')}>
        <TableHeader>
          <TableRow>
            {selectable && (
              <TableHeaderCell className={styles.checkColumn}>
                <Checkbox
                  aria-label={t('time.selectAll')}
                  checked={selected.length > 0 && selected.length === approvable.length ? true : selected.length > 0 ? 'mixed' : false}
                  disabled={approvable.length === 0}
                  onChange={(_, d) => onSelect(d.checked ? approvable : [])}
                />
              </TableHeaderCell>
            )}
            <TableHeaderCell className={styles.dateColumn}>{t('time.fields.workDate')}</TableHeaderCell>
            <TableHeaderCell className={styles.customerColumn}>{t('time.fields.organization')}</TableHeaderCell>
            <TableHeaderCell>{t('time.fields.work')}</TableHeaderCell>
            <TableHeaderCell className={mergeClasses(catalog.number, styles.hoursColumn)}>{t('time.fields.hours')}</TableHeaderCell>
            <TableHeaderCell className={styles.billingColumn}>{t('time.fields.billing')}</TableHeaderCell>
            {canSeeMoney && <TableHeaderCell className={mergeClasses(catalog.number, styles.amountColumn)}>{t('time.fields.amount')}</TableHeaderCell>}
            {withAdjust && <TableHeaderCell className={styles.actionColumn} />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.id}>
              {selectable && (
                <TableCell>
                  {/* Billed work and closed months cannot be selected: no checkbox rather than a disabled one. */}
                  {actionable(entry) && (
                    <Checkbox
                      aria-label={t('time.selectEntry', { date: formatDate(entry.workDate), organization: entry.organizationName ?? '' })}
                      checked={selected.includes(entry.id)}
                      onChange={(_, d) => onSelect(d.checked ? [...selected, entry.id] : selected.filter((id) => id !== entry.id))}
                    />
                  )}
                </TableCell>
              )}
              <TableCell className="tabular">{formatDate(entry.workDate)}</TableCell>
              <TableCell>
                <span className={styles.stackCell}>
                  <AppLink to={`/organizations/${entry.organizationId}`} className={styles.org}>{entry.organizationName}</AppLink>
                  {entry.technicianName && <span className={styles.meta}>{entry.technicianName}</span>}
                </span>
              </TableCell>
              <TableCell><WorkCell entry={entry} canReview={canReview} /></TableCell>
              <TableCell className={catalog.number}>{formatNumber(entry.hours)}</TableCell>
              <TableCell><BillingParts entry={entry} /></TableCell>
              {canSeeMoney && <TableCell className={catalog.number}>{formatMoney(entry.amount)}</TableCell>}
              {withAdjust && (
                <TableCell>
                  {adjustable(entry) && (
                    <Button {...restoreFocusTarget} size="small" appearance="subtle" onClick={() => onAdjust(entry)}
                      aria-label={t('time.adjustNamed', { date: formatDate(entry.workDate), organization: entry.organizationName ?? '' })}>
                      {t('time.adjust')}
                    </Button>
                  )}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollTable>
  );
}

function TimeEntryRows({ entries, selectable, canManage, canReview, canSeeMoney, selected, onSelect, onAdjust }: TimeEntriesTableProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  const restoreFocusTarget = useRestoreFocusTarget();
  const approvable = entries.filter(adjustable).map((e) => e.id);

  return (
    <>
      {selectable && approvable.length > 0 && (
        <div className={styles.selectAll}>
          <Checkbox
            label={t('time.selectAll')}
            checked={selected.length > 0 && selected.length === approvable.length ? true : selected.length > 0 ? 'mixed' : false}
            onChange={(_, d) => onSelect(d.checked ? approvable : [])}
          />
        </div>
      )}
      <ul className={styles.list} aria-label={t('time.title')}>
        {entries.map((entry) => (
          <li key={entry.id} className={mergeClasses(styles.card, selectable && styles.withCheck)}>
            {selectable && (
              <span className={styles.check}>
                {actionable(entry) && (
                  <Checkbox
                    aria-label={t('time.selectEntry', { date: formatDate(entry.workDate), organization: entry.organizationName ?? '' })}
                    checked={selected.includes(entry.id)}
                    onChange={(_, d) => onSelect(d.checked ? [...selected, entry.id] : selected.filter((id) => id !== entry.id))}
                  />
                )}
              </span>
            )}
            <div className={styles.cardBody}>
              <span className={styles.cardTop}>
                <AppLink to={`/organizations/${entry.organizationId}`} className={styles.org}>{entry.organizationName}</AppLink>
                <span className={styles.figures}>{formatNumber(entry.hours)} {t('contracts.hoursShort')}</span>
              </span>
              <span className={styles.when}>
                {[formatDate(entry.workDate), entry.technicianName].filter(Boolean).join(' · ')}
              </span>
              <WorkCell entry={entry} canReview={canReview} />
              <span className={styles.cardEnd}>
                <BillingParts entry={entry} />
                {canSeeMoney && <span className={styles.figures}>{formatMoney(entry.amount)}</span>}
                {canManage && adjustable(entry) && (
                  <Button {...restoreFocusTarget} size="small" appearance="subtle" onClick={() => onAdjust(entry)}
                    aria-label={t('time.adjustNamed', { date: formatDate(entry.workDate), organization: entry.organizationName ?? '' })}>
                    {t('time.adjust')}
                  </Button>
                )}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
