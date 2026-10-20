import { useState } from 'react';
import {
  Button,
  Checkbox,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
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
  form: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalL },
  narrow: { width: '160px' },
  totals: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalL, marginBottom: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

const januaryNextYear = () => `${new Date().getFullYear() + 1}-01-01`;

/** Yearly price indexation of contracts (FR-CON-05): set the percentage, see before and after, then apply. */
export function IndexationPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const [percentText, setPercentText] = useState('3.5');
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
        t('contracts.indexation.applied', { contracts: result.contracts, lines: result.lines }),
        result.skipped.length > 0 ? 'warning' : 'success',
        result.skipped.length > 0 ? t('contracts.indexation.skipped', { count: result.skipped.length }) : undefined,
      );
      setSelected(new Set());
      await preview.refetch();
    } catch (e) {
      notify(t('contracts.indexation.failed'), 'error', errorMessage(e, t));
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: '/contracts', label: t('contracts.title') }}
        title={t('contracts.indexation.title')}
        subtitle={t('contracts.indexation.subtitle')}
      />

      <div className={styles.form}>
        <Field label={t('contracts.indexation.percent')} className={styles.narrow} hint={t('contracts.indexation.percentHint')}>
          <Input inputMode="decimal" value={percentText} onChange={(_, d) => setPercentText(d.value)} contentAfter="%" />
        </Field>
        <Field label={t('contracts.indexation.effectiveFrom')} className={styles.narrow}>
          <Input type="date" value={effectiveFrom} onChange={(_, d) => setEffectiveFrom(d.value)} />
        </Field>
        <Button appearance="primary" onClick={runPreview} disabled={percent === 0 || !effectiveFrom}>
          {t('contracts.indexation.preview')}
        </Button>
      </div>

      {preview.isFetching && <Spinner label={t('common.loading')} />}
      {preview.error && <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />}

      {asked && !preview.isFetching && !preview.error && (
        contracts.length === 0 ? (
          <EmptyState message={t('contracts.indexation.empty')} />
        ) : (
          <>
            <div className={styles.totals}>
              <Text>
                {t('contracts.indexation.selected', { selected: chosen.length, total: contracts.length })}
              </Text>
              {totals?.monthlyBefore != null && (
                <Text>{t('contracts.indexation.monthlyChange', { before: formatMoney(totals.monthlyBefore), after: formatMoney(totals.monthlyAfter) })}</Text>
              )}
            </div>

            <ScrollTable className={catalog.tableWrap}>
              <Table className={catalog.table} aria-label={t('contracts.indexation.title')}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>
                      <Checkbox
                        checked={chosen.length > 0 && chosen.length === contracts.length}
                        onChange={(_, d) => setSelected(d.checked ? new Set(contracts.map((c) => c.contractId)) : new Set())}
                        aria-label={t('contracts.indexation.selectAll')}
                      />
                    </TableHeaderCell>
                    <TableHeaderCell>{t('contracts.fields.contract')}</TableHeaderCell>
                    <TableHeaderCell>{t('contracts.fields.organization')}</TableHeaderCell>
                    <TableHeaderCell>{t('contracts.indexation.due')}</TableHeaderCell>
                    <TableHeaderCell className={catalog.number}>{t('contracts.indexation.before')}</TableHeaderCell>
                    <TableHeaderCell className={catalog.number}>{t('contracts.indexation.after')}</TableHeaderCell>
                    <TableHeaderCell className={catalog.number}>{t('contracts.indexation.lines')}</TableHeaderCell>
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
                        <AppLink to={`/contracts/${contract.contractId}`}>{contract.title}</AppLink>
                        <div className={catalog.sku}>{contract.number}</div>
                      </TableCell>
                      <TableCell>
                        <AppLink to={`/organizations/${contract.organization.id}?tab=contracts`}>{contract.organization.name}</AppLink>
                      </TableCell>
                      <TableCell className="tabular">
                        {contract.nextIndexationDate ? formatDate(contract.nextIndexationDate) : '—'}
                      </TableCell>
                      <TableCell className={catalog.number}>{formatMoney(contract.monthlyBefore ?? 0)}</TableCell>
                      <TableCell className={catalog.number}>{formatMoney(contract.monthlyAfter ?? 0)}</TableCell>
                      <TableCell className={catalog.number}>
                        {formatNumber(contract.lines.length, 0)}
                        {contract.priceListLines > 0 && (
                          <div className={styles.muted}>{t('contracts.indexation.priceListLines', { count: contract.priceListLines })}</div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollTable>

            <MessageBar intent="info" style={{ marginTop: 12 }}>
              <MessageBarBody>{t('contracts.indexation.notifyHint')}</MessageBarBody>
            </MessageBar>

            <div style={{ marginTop: 12 }}>
              <Button appearance="primary" disabled={chosen.length === 0 || apply.isPending} onClick={() => void run()}>
                {t('contracts.indexation.apply', { count: chosen.length })}
              </Button>
            </div>
          </>
        )
      )}
    </>
  );
}
