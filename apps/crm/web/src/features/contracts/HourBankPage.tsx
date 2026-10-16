import { useState } from 'react';
import { useParams } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
  DialogSurface,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useHourBank, useHourBankActions } from './api';
import { HoursMeter } from './ContractBadges';
import { HourBankEntryForm } from './ContractDialogs';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start', marginBottom: tokens.spacingVerticalL },
  big: { fontSize: tokens.fontSizeHero800, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums', lineHeight: tokens.lineHeightHero800 },
  balance: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  negative: { color: tokens.colorPaletteRedForeground1 },
});

export function HourBankPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const notify = useNotify();
  const { data: bank, error, isPending, refetch } = useHourBank(id);
  const actions = useHourBankActions();
  const canWrite = useCan(Permissions.contractsWrite);
  const canSeePrices = useCan(Permissions.financeRead);
  const [adding, setAdding] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const close = async () => {
    try {
      await actions.close.mutateAsync(bank.id);
      notify(t('contracts.hourBanks.closedDone'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <>
      <PageHeader
        back={bank.contractId ? { to: `/contracts/${bank.contractId}`, label: bank.contractNumber ?? t('contracts.title') } : { to: `/organizations/${bank.organization.id}?tab=contracts`, label: bank.organization.name }}
        title={bank.name}
        meta={
          <>
            <AppLink to={`/organizations/${bank.organization.id}`}>{bank.organization.name}</AppLink>
            {bank.isLow && bank.status === 'Active' && <Badge appearance="tint" color="warning">{t('contracts.hourBanks.low')}</Badge>}
            {bank.status === 'Closed' && <Badge appearance="outline" color="informative">{t('contracts.hourBanks.closed')}</Badge>}
          </>
        }
        actions={
          canWrite &&
          bank.status === 'Active' && (
            <>
              <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setAdding(true)}>
                {t('contracts.hourBanks.addEntry')}
              </Button>
              <Button onClick={() => void close()}>{t('contracts.hourBanks.close')}</Button>
            </>
          )
        }
      />
      <div className={styles.grid}>
        <Panel title={t('contracts.hourBanks.balance')}>
          <div className={styles.balance}>
            <span className={styles.big}>
              {formatNumber(bank.remainingHours)} {t('contracts.hoursShort')}
            </span>
            <HoursMeter remaining={bank.remainingHours} purchased={bank.purchasedHours} isLow={bank.isLow} />
            <span className={catalog.muted}>{t('contracts.hourBanks.balanceDetail', { used: formatNumber(bank.usedHours), purchased: formatNumber(bank.purchasedHours), pct: formatNumber(bank.lowBalancePct, 0) })}</span>
          </div>
        </Panel>
        <Panel title={t('contracts.sections.term')}>
          <DetailList
            items={[
              { label: t('contracts.fields.period'), value: `${formatDate(bank.validFrom)} – ${bank.validTo ? formatDate(bank.validTo) : t('contracts.untilFurtherNotice')}` },
              { label: t('contracts.hourBanks.overageHours'), value: bank.overageHours > 0 ? `${formatNumber(bank.overageHours)} ${t('contracts.hoursShort')}` : null },
              ...(canSeePrices ? [{ label: t('contracts.fields.overageRate'), value: formatMoney(bank.overageRate) }] : []),
            ]}
          />
        </Panel>
      </div>
      <Panel title={t('contracts.hourBanks.ledger')}>
        <div style={{ overflowX: 'auto' }}>
          <Table aria-label={t('contracts.hourBanks.ledger')} style={{ minWidth: 640 }}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('contracts.fields.date')}</TableHeaderCell>
                <TableHeaderCell>{t('contracts.fields.entryKind')}</TableHeaderCell>
                <TableHeaderCell>{t('contracts.fields.entryDescription')}</TableHeaderCell>
                <TableHeaderCell className={catalog.number}>{t('contracts.fields.hours')}</TableHeaderCell>
                <TableHeaderCell>{t('contracts.hourBanks.by')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(bank.entries ?? []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="tabular">{formatDate(e.date)}</TableCell>
                  <TableCell>{t(`contracts.entryKinds.${e.kind}`)}</TableCell>
                  <TableCell>{e.description}</TableCell>
                  <TableCell className={catalog.number}>
                    <span className={e.hours < 0 ? styles.negative : undefined}>
                      {e.hours > 0 ? '+' : ''}
                      {formatNumber(e.hours)}
                    </span>
                    {e.overageHours > 0 && <div className={catalog.muted}>{t('contracts.hourBanks.overage', { hours: formatNumber(e.overageHours) })}</div>}
                  </TableCell>
                  <TableCell>{e.createdBy?.name ?? e.sourceType}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Panel>
      <Dialog open={adding} onOpenChange={(_, d) => !d.open && setAdding(false)}>
        <DialogSurface>{adding && <HourBankEntryForm bankId={bank.id} onClose={() => setAdding(false)} />}</DialogSurface>
      </Dialog>
    </>
  );
}
