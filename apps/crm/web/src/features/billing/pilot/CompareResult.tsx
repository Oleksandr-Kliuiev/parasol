import { useState } from 'react';
import { Button, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles } from '@fluentui/react-components';
import { DataBarHorizontalDescending16Regular, Warning16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { Panel } from '../../../shared/components/Panel';
import { FilterChips } from '../../../shared/components/Toolbar';
import { formatDateTime, formatNumber } from '../../../shared/utils/format';
import { FigureGrid } from '../../reports/FigureGrid';
import { compareStatuses, type CompareItem, type ComparisonResult } from './api';
import { KeyText, ScrollRegion, Verdict } from './parts';
import { money, usePilotStyles } from './styles';

const PAGE = 100;

const useStyles = makeStyles({
  // How many keys still need an explanation: the figure that decides the sign-off, said once and in its tone.
  toExplain: { display: 'inline-flex', alignItems: 'center', gap: '8px', marginTop: '12px', color: h.saffronT, fontWeight: 600 },
  keysHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px 12px', marginTop: '20px', marginBottom: '10px' },
});

function itemLabel(item: CompareItem): string {
  return item.key;
}

/** The comparison as stored: per-key verdicts, per-payer summary and totals per currency, with the id and the hash that a sign-off names. */
export function CompareResult({ result }: { result: ComparisonResult }) {
  const styles = usePilotStyles();
  const local = useStyles();
  const { t } = useTranslation();
  const doc = result.comparison;
  const [exceptionsOnly, setExceptionsOnly] = useState(true);
  const [shown, setShown] = useState(PAGE);
  const items = exceptionsOnly ? doc.items.filter((i) => i.status !== 'Matched') : doc.items;
  const visible = items.slice(0, shown);

  return (
    <Panel title={t('pilot.result.title')} icon={<DataBarHorizontalDescending16Regular />}>
      {/* What a sign-off names, kept whole: the comparison id and both fingerprints. */}
      <dl className={styles.evidence}>
        <div className={styles.fact}>
          <dt className={styles.term}>{t('pilot.result.comparisonId')}</dt>
          <dd className={styles.mono}>{doc.comparisonId}</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.term}>{t('pilot.result.made')}</dt>
          <dd>{t('pilot.result.madeText', { at: formatDateTime(doc.at), rows: doc.fileRows, revision: doc.runContentRevision })}</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.term}>{t('pilot.result.documentSha')}</dt>
          <dd className={styles.key}>{result.documentSha256}</dd>
        </div>
        <div className={styles.fact}>
          <dt className={styles.term}>{t('pilot.result.fileSha')}</dt>
          <dd className={styles.key}>{doc.fileSha256}</dd>
        </div>
      </dl>
      {doc.unknownColumns.length > 0 && (
        <p className={styles.lead}>{t('pilot.result.unknownColumns', { columns: doc.unknownColumns.join(', ') })}</p>
      )}

      <h3 className={styles.heading}>{t('pilot.result.counts')}</h3>
      <FigureGrid items={compareStatuses.map((status) => ({ label: t(`pilot.verdict.${status}`, { defaultValue: status }), value: String(doc.statusCounts[status] ?? 0) }))} />
      <p className={local.toExplain}>
        {doc.exceptionCount > 0 && <Warning16Regular aria-hidden />}
        <Text weight="semibold" className={doc.exceptionCount > 0 ? styles.warn : styles.good}>{t('pilot.result.exceptions', { number: doc.exceptionCount })}</Text>
      </p>

      <h3 className={styles.heading}>{t('pilot.result.totals')}</h3>
      <ScrollRegion label={t('pilot.result.totals')}>
        <Table className={styles.table} aria-label={t('pilot.result.totals')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('pilot.result.currency')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.keys')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.exceptionsColumn')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.fileAmount')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.crmAmount')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.difference')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {doc.totals.map((row) => (
              <TableRow key={row.currency}>
                <TableCell>{row.currency}</TableCell>
                <TableCell className={styles.number}>{row.keys}</TableCell>
                <TableCell className={styles.number}>{row.exceptions}</TableCell>
                <TableCell className={styles.number}>{money(row.fileAmount, row.currency)}</TableCell>
                <TableCell className={styles.number}>{money(row.crmAmount, row.currency)}</TableCell>
                <TableCell className={styles.number}>{money(row.difference, row.currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollRegion>

      <h3 className={styles.heading}>{t('pilot.result.payers')}</h3>
      <ScrollRegion label={t('pilot.result.payers')}>
        <Table className={styles.table} aria-label={t('pilot.result.payers')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('pilot.result.payer')}</TableHeaderCell>
              <TableHeaderCell>{t('pilot.result.currency')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.keys')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.exceptionsColumn')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.fileAmount')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.crmAmount')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.difference')}</TableHeaderCell>
              <TableHeaderCell>{t('common.status')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {doc.payers.map((row) => (
              <TableRow key={`${row.payerKey}-${row.currency}`}>
                <TableCell className={styles.mono}>{row.orgNumber ?? row.payerKey}</TableCell>
                <TableCell>{row.currency}</TableCell>
                <TableCell className={styles.number}>{row.keys}</TableCell>
                <TableCell className={styles.number}>{row.exceptions}</TableCell>
                <TableCell className={styles.number}>{money(row.fileAmount, row.currency)}</TableCell>
                <TableCell className={styles.number}>{money(row.crmAmount, row.currency)}</TableCell>
                <TableCell className={styles.number}>{money(row.difference, row.currency)}</TableCell>
                <TableCell>
                  <Verdict status={row.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollRegion>

      <div className={local.keysHead}>
        <h3 className={styles.heading} style={{ marginTop: 0, marginBottom: 0 }}>{t('pilot.result.keysTitle')}</h3>
        <FilterChips
          label={t('pilot.result.exceptionsOnly')}
          value={exceptionsOnly ? 'on' : ''}
          options={[{ value: 'on', label: t('pilot.result.exceptionsOnly') }]}
          onChange={() => {
            setExceptionsOnly(!exceptionsOnly);
            setShown(PAGE);
          }}
        />
      </div>
      <ScrollRegion label={t('pilot.result.keysTitle')}>
        <Table className={styles.table} style={{ minWidth: 960 }} aria-label={t('pilot.result.keysTitle')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('pilot.result.key')}</TableHeaderCell>
              <TableHeaderCell>{t('pilot.result.verdict')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.quantities')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.fileAmount')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.crmAmount')}</TableHeaderCell>
              <TableHeaderCell className={styles.number}>{t('pilot.result.difference')}</TableHeaderCell>
              <TableHeaderCell>{t('pilot.result.reason')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((item) => (
              <TableRow key={item.key}>
                <TableCell>
                  <span className={styles.keyText}><KeyText value={itemLabel(item)} /></span>
                  {item.line !== null && <div className={styles.muted}>{t('pilot.result.fileLine', { line: item.line })}</div>}
                </TableCell>
                <TableCell>
                  <Verdict status={item.status} />
                </TableCell>
                <TableCell className={styles.number}>
                  {item.fileQuantity === null && item.crmQuantity === null ? '—' : `${formatNumber(item.fileQuantity) || '—'} / ${formatNumber(item.crmQuantity) || '—'}`}
                </TableCell>
                <TableCell className={styles.number}>{money(item.fileAmount, item.currency)}</TableCell>
                <TableCell className={styles.number}>{money(item.crmAmount, item.currency)}</TableCell>
                <TableCell className={styles.number}>{money(item.difference, item.currency)}</TableCell>
                <TableCell>{item.reasonCode ? t(`pilot.reasons.${item.reasonCode}`, { defaultValue: item.reasonCode }) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollRegion>
      <div className={styles.footer}>
        <Text className={styles.muted} aria-live="polite">
          {t('common.shownOf', { shown: visible.length, total: items.length })}
        </Text>
        {visible.length < items.length && <Button onClick={() => setShown((n) => n + PAGE)}>{t('common.loadMore')}</Button>}
      </div>
    </Panel>
  );
}
