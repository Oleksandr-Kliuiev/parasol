import { useState } from 'react';
import { useParams } from 'react-router';
import {
  Badge,
  Button,
  DialogSurface,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { Add20Regular, CalendarLtr16Regular, History16Regular, History24Regular, HourglassHalf16Regular, LockClosed20Regular, MoreHorizontal20Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { useRecordStyles } from '../organizations/recordStyles';
import { DetailList, FactGrid, Panel } from '../../shared/components/Panel';
import { EmptyState } from '../../shared/components/EmptyState';
import { RecordCell } from '../organizations/RecordCell';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useHourBank, useHourBankActions } from './api';
import { HoursMeter } from './ContractBadges';
import { HourBankEntryForm } from './ContractDialogs';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '16px', alignItems: 'start', marginBottom: '16px' },
  big: { fontFamily: h.display, fontSize: 'clamp(28px, 2.6vw, 38px)', fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 },
  balance: { display: 'flex', flexDirection: 'column', gap: '12px' },
  negative: { color: h.emberT },
  person: { fontWeight: 500, fontSize: '13px' },
});

/** Who booked a movement the system made: approved time and its withdrawal, never the raw source name. */
const knownSources = ['TimeEntry', 'TimeEntryReversal'];

export function HourBankPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const record = useRecordStyles();
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const notify = useNotify();
  const { data: bank, error, isPending, refetch } = useHourBank(id);
  const actions = useHourBankActions();
  const canWrite = useCan(Permissions.contractsWrite);
  const canSeePrices = useCan(Permissions.financeRead);
  const [adding, setAdding] = useState(false);
  const [closing, setClosing] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const close = async () => {
    try {
      await actions.close.mutateAsync(bank.id);
      setClosing(false);
      notify(t('contracts.hourBanks.closedDone'));
    } catch {
      // The dialog stays open and says why; the person decides again.
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
            {bank.status === 'Closed' && <Badge appearance="tint" color="subtle">{t('contracts.hourBanks.closed')}</Badge>}
          </>
        }
        actions={
          canWrite &&
          bank.status === 'Active' && (
            <>
              <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setAdding(true)}>
                {t('contracts.hourBanks.addEntry')}
              </Button>
              {/* Closing cannot be undone, so it is one step away from the everyday action and asks first. */}
              <Menu positioning="below-end">
                <MenuTrigger disableButtonEnhancement>
                  <Button {...restoreFocusTarget} icon={<MoreHorizontal20Regular />} aria-label={t('contracts.hourBanks.moreActions')} />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem icon={<LockClosed20Regular />} onClick={() => setClosing(true)}>{t('contracts.hourBanks.closeAsk')}</MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
            </>
          )
        }
      />
      <div className={styles.grid}>
        <Panel title={t('contracts.hourBanks.balance')} icon={<HourglassHalf16Regular />}>
          <div className={styles.balance}>
            <span className={styles.big}>
              {formatNumber(bank.remainingHours)} {t('contracts.hoursShort')}
            </span>
            <HoursMeter remaining={bank.remainingHours} purchased={bank.purchasedHours} isLow={bank.isLow} wide />
            <FactGrid
              items={[
                { label: t('contracts.hourBanks.purchased'), value: `${formatNumber(bank.purchasedHours)} ${t('contracts.hoursShort')}` },
                { label: t('contracts.hourBanks.used'), value: `${formatNumber(bank.usedHours)} ${t('contracts.hoursShort')}` },
                { label: t('contracts.hourBanks.warnBelow'), value: `${formatNumber(bank.lowBalancePct, 0)} %` },
              ]}
            />
          </div>
        </Panel>
        <Panel title={t('contracts.sections.term')} icon={<CalendarLtr16Regular />}>
          <DetailList
            items={[
              { label: t('contracts.fields.period'), value: `${formatDate(bank.validFrom)} – ${bank.validTo ? formatDate(bank.validTo) : t('contracts.untilFurtherNotice')}` },
              { label: t('contracts.hourBanks.overageHours'), value: bank.overageHours > 0 ? `${formatNumber(bank.overageHours)} ${t('contracts.hoursShort')}` : null },
              ...(canSeePrices ? [{ label: t('contracts.fields.overageRate'), value: formatMoney(bank.overageRate) }] : []),
            ]}
          />
        </Panel>
      </div>
      <Panel title={t('contracts.hourBanks.ledger')} icon={<History16Regular />}>
        {(bank.entries ?? []).length === 0 ? (
          <EmptyState icon={<History24Regular />} message={t('contracts.hourBanks.noEntries')} />
        ) : (
          <ScrollTable className={record.flatTable}>
            <Table aria-label={t('contracts.hourBanks.ledger')} style={{ minWidth: 780 }}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell style={{ width: 96 }}>{t('contracts.fields.date')}</TableHeaderCell>
                  <TableHeaderCell style={{ width: 116 }}>{t('contracts.fields.entryKind')}</TableHeaderCell>
                  <TableHeaderCell>{t('contracts.fields.entryDescription')}</TableHeaderCell>
                  <TableHeaderCell className={catalog.number} style={{ width: 96 }}>{t('contracts.fields.hours')}</TableHeaderCell>
                  <TableHeaderCell style={{ width: 176 }}>{t('contracts.hourBanks.by')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(bank.entries ?? []).map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="tabular">{formatDate(e.date)}</TableCell>
                    <TableCell>{t(`contracts.entryKinds.${e.kind}`)}</TableCell>
                    <TableCell>{e.description ?? '—'}</TableCell>
                    <TableCell className={catalog.number}>
                      <span className={e.hours < 0 ? styles.negative : undefined}>
                        {e.hours > 0 ? '+' : ''}
                        {formatNumber(e.hours)}
                      </span>
                      {e.overageHours > 0 && <div className={catalog.muted}>{t('contracts.hourBanks.overage', { hours: formatNumber(e.overageHours) })}</div>}
                    </TableCell>
                    <TableCell>
                      {e.createdBy ? (
                        <RecordCell avatarName={e.createdBy.name} size={28} name={<span className={styles.person}>{e.createdBy.name}</span>} />
                      ) : (
                        <span className={catalog.muted}>
                          {t(`contracts.hourBanks.sources.${e.sourceType && knownSources.includes(e.sourceType) ? e.sourceType : 'other'}`)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        )}
      </Panel>
      <Dialog open={adding} onOpenChange={(_, d) => !d.open && setAdding(false)}>
        <DialogSurface><HourBankEntryForm bankId={bank.id} onClose={() => setAdding(false)} /></DialogSurface>
      </Dialog>
      <ConfirmDialog open={closing} title={t('contracts.hourBanks.closeTitle', { name: bank.name })} confirm={t('contracts.hourBanks.closeConfirm')}
        busy={actions.close.isPending} error={actions.close.error ? errorMessage(actions.close.error, t) : null}
        onConfirm={() => void close()} onCancel={() => { setClosing(false); actions.close.reset(); }}>
        {t('contracts.hourBanks.closeBody', { hours: formatNumber(bank.remainingHours) })}
      </ConfirmDialog>
    </>
  );
}
