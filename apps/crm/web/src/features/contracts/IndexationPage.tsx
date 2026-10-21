import { useState } from 'react';
import {
  Button,
  Checkbox,
  Field,
  Input,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
} from '@fluentui/react-components';
import { ArrowTrending16Regular, ArrowTrending24Regular, DocumentText16Regular, TextBulletListLtr16Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { FactGrid, Panel } from '../../shared/components/Panel';
import { RecordCell } from '../organizations/RecordCell';
import { useRecordStyles } from '../organizations/recordStyles';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber, parseDecimal } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useApplyIndexation, useIndexationPreview } from './api';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  // Label above, hint under, the button on the row of the controls; one column on a phone.
  form: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 240px) minmax(0, 240px) auto',
    justifyContent: 'start',
    alignItems: 'start',
    gap: '14px 16px',
    '@media (max-width: 600px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  submit: {
    display: 'flex',
    alignItems: 'center',
    minHeight: '42px',
    marginTop: '24px',
    '@media (max-width: 600px)': { marginTop: 0, '& > .fui-Button': { flexGrow: 1 } },
  },
  facts: { marginBottom: '16px' },
  // Column widths are content widths: every cell adds 12 px of padding on each side.
  check: { width: '28px' },
  link: { fontWeight: 700, color: 'inherit' },
  // The reminder and the action that it is about, at the foot of the preview.
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px 16px',
    paddingTop: '14px',
    marginTop: '4px',
    borderTop: `1px solid ${h.line}`,
  },
  note: { maxWidth: '75ch', color: h.muted, fontSize: '13px', lineHeight: '19px' },
  // The action keeps to the right edge, also when the note above it takes the whole line.
  apply: { marginLeft: 'auto' },
});

const januaryNextYear = () => `${new Date().getFullYear() + 1}-01-01`;

/** Yearly price indexation of contracts (FR-CON-05): set the percentage, see before and after, then apply. */
export function IndexationPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  // No percentage is suggested: a figure here would read as this year's index (the person looks it up and types it).
  const [percentText, setPercentText] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(januaryNextYear());
  const [asked, setAsked] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const percent = parseDecimal(percentText) ?? 0;
  const preview = useIndexationPreview(percent, effectiveFrom, asked);
  const apply = useApplyIndexation();
  const contracts = preview.data?.contracts ?? [];
  // Only contracts of the preview on screen count as chosen: a selection from an earlier percentage or date is not sent (DEV-12).
  const chosen = contracts.filter((c) => selected.has(c.contractId));
  const totals = preview.data?.totals;

  const runPreview = () => {
    setAsked(true);
    setSelected(new Set());
  };

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  const run = async () => {
    try {
      const result = await apply.mutateAsync({ percent, effectiveFrom, contractIds: chosen.map((c) => c.contractId) });
      notify(
        t('contracts.indexation.applied', {
          contracts: t('contracts.indexation.contractCount', { count: result.contracts }),
          lines: t('contracts.indexation.lineCount', { count: result.lines }),
        }),
        result.skipped.length > 0 ? 'warning' : 'success',
        result.skipped.length > 0 ? t('contracts.indexation.skipped', { count: result.skipped.length }) : undefined,
      );
      setSelected(new Set());
      await preview.refetch();
    } catch (e) {
      notify(t('contracts.indexation.failed'), 'error', errorMessage(e, t));
    }
  };

  const facts = [
    { label: t('contracts.indexation.dueLabel'), value: formatNumber(contracts.length, 0) },
    { label: t('contracts.indexation.selectedLabel'), value: t('contracts.indexation.selectedValue', { selected: chosen.length, total: contracts.length }) },
    ...(totals?.monthlyBefore != null
      ? [
          { label: t('contracts.indexation.before'), value: formatMoney(totals.monthlyBefore) },
          { label: t('contracts.indexation.after'), value: formatMoney(totals.monthlyAfter) },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        back={{ to: '/contracts', label: t('contracts.title') }}
        title={t('contracts.indexation.title')}
        subtitle={t('contracts.indexation.subtitle')}
      />

      <div className={styles.stack}>
        <Panel title={t('contracts.indexation.setupTitle')} icon={<ArrowTrending16Regular />}>
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (percent !== 0 && effectiveFrom) runPreview(); }}>
            <Field label={t('contracts.indexation.percent')} hint={t('contracts.indexation.percentHint')}>
              <Input inputMode="decimal" value={percentText} onChange={(_, d) => setPercentText(d.value)} contentAfter="%" />
            </Field>
            <Field label={t('contracts.indexation.effectiveFrom')}>
              <Input type="date" value={effectiveFrom} onChange={(_, d) => setEffectiveFrom(d.value)} />
            </Field>
            <div className={styles.submit}>
              <Button type="submit" appearance={asked ? 'secondary' : 'primary'} disabled={percent === 0 || !effectiveFrom}>
                {t('contracts.indexation.preview')}
              </Button>
            </div>
          </form>
        </Panel>

        {asked && (
          <Panel title={t('contracts.indexation.previewTitle')} icon={<TextBulletListLtr16Regular />}>
            {preview.isFetching ? (
              <Spinner label={t('common.loading')} />
            ) : preview.error ? (
              <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
            ) : contracts.length === 0 ? (
              <EmptyState icon={<ArrowTrending24Regular />} message={t('contracts.indexation.empty')} />
            ) : (
              <>
                <FactGrid className={styles.facts} items={facts} />
                <ScrollTable className={record.flatTable}>
                  <Table className={catalog.table} style={{ minWidth: 1060 }} aria-label={t('contracts.indexation.title')}>
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell className={styles.check}>
                          <Checkbox
                            checked={chosen.length > 0 && chosen.length === contracts.length ? true : chosen.length > 0 ? 'mixed' : false}
                            onChange={(_, d) => setSelected(d.checked ? new Set(contracts.map((c) => c.contractId)) : new Set())}
                            aria-label={t('contracts.indexation.selectAll')}
                          />
                        </TableHeaderCell>
                        <TableHeaderCell style={{ width: 236 }}>{t('contracts.fields.contract')}</TableHeaderCell>
                        <TableHeaderCell>{t('contracts.fields.organization')}</TableHeaderCell>
                        <TableHeaderCell style={{ width: 96 }}>{t('contracts.indexation.due')}</TableHeaderCell>
                        <TableHeaderCell className={catalog.number} style={{ width: 126 }}>{t('contracts.indexation.before')}</TableHeaderCell>
                        <TableHeaderCell className={catalog.number} style={{ width: 126 }}>{t('contracts.indexation.after')}</TableHeaderCell>
                        <TableHeaderCell className={catalog.number} style={{ width: 126 }}>{t('contracts.indexation.lines')}</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contracts.map((contract) => (
                        <TableRow key={contract.contractId}>
                          <TableCell>
                            <Checkbox
                              checked={selected.has(contract.contractId)}
                              onChange={(_, d) => toggle(contract.contractId, Boolean(d.checked))}
                              aria-label={contract.number}
                            />
                          </TableCell>
                          <TableCell>
                            <RecordCell
                              icon={<DocumentText16Regular />}
                              tone="iris"
                              name={<AppLink to={`/contracts/${contract.contractId}`} className={styles.link}>{contract.title}</AppLink>}
                              meta={[contract.number]}
                            />
                          </TableCell>
                          <TableCell>
                            <RecordCell
                              avatarName={contract.organization.name}
                              size={28}
                              name={<AppLink to={`/organizations/${contract.organization.id}?tab=contracts`} className={record.quietLink}>{contract.organization.name}</AppLink>}
                            />
                          </TableCell>
                          <TableCell className="tabular">
                            {contract.nextIndexationDate ? formatDate(contract.nextIndexationDate) : '—'}
                          </TableCell>
                          <TableCell className={catalog.number}>{formatMoney(contract.monthlyBefore ?? 0)}</TableCell>
                          <TableCell className={catalog.number}>{formatMoney(contract.monthlyAfter ?? 0)}</TableCell>
                          <TableCell className={catalog.number}>
                            {formatNumber(contract.lines.length, 0)}
                            {contract.priceListLines > 0 && (
                              <div className={catalog.muted}>{t('contracts.indexation.priceListLines', { count: contract.priceListLines })}</div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollTable>
                <div className={styles.footer}>
                  <Text className={styles.note}>{t('contracts.indexation.notifyHint')}</Text>
                  <Button className={styles.apply} appearance="primary" disabled={chosen.length === 0 || apply.isPending} onClick={() => void run()}>
                    {t('contracts.indexation.apply', { count: chosen.length })}
                  </Button>
                </div>
              </>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}
