import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Edit20Regular, MoreHorizontal20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { CustomFieldsPanel } from '../customfields/CustomFieldsPanel';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatMoney, formatNumber, todayIso } from '../../shared/utils/format';
import { HistoryList } from '../audit/HistoryList';
import { useCatalogStyles } from '../catalog/styles';
import { NotFoundPage } from '../errors/NotFoundPage';
import { useContract, useContractActions } from './api';
import { ContractStatusBadge } from './ContractBadges';
import { DateActionForm, HourBankForm, LineForm, ReviseLineForm } from './ContractDialogs';
import { HourBankList } from './HourBankList';
import type { Contract, ContractLine } from './types';
import { ScrollTabList } from '../../shared/components/ScrollTabList';

const useStyles = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, overflowX: 'auto', overflowY: 'hidden', scrollPaddingInline: '16px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  value: { fontSize: tokens.fontSizeHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums', lineHeight: tokens.lineHeightHero700 },
  lineTools: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM, marginBottom: tokens.spacingVerticalM },
  past: { color: tokens.colorNeutralForeground3 },
});

type Dialogs =
  | { kind: 'line' }
  | { kind: 'revise'; line: ContractLine }
  | { kind: 'notice' }
  | { kind: 'end' }
  | { kind: 'endLine'; line: ContractLine }
  | { kind: 'hourBank' }
  | { kind: 'delete' };

export function ContractDetailPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'history' ? 'history' : 'overview';
  const { data, error, isPending, refetch } = useContract(id);
  const actions = useContractActions(id);
  const canWrite = useCan(Permissions.contractsWrite);
  const canSeePrices = useCan(Permissions.financeRead);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  const c = data.data;
  const close = () => setDialog(null);

  const transition = async (action: 'activate' | 'suspend' | 'withdraw-notice') => {
    try {
      await actions.transition.mutateAsync({ action });
      notify(t(`contracts.transitions.${action}`));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const remove = async () => {
    try {
      await actions.remove.mutateAsync();
      notify(t('contracts.deleted'));
      navigate('/contracts');
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: '/contracts', label: t('contracts.title') }}
        title={c.title}
        meta={
          <>
            <Text style={{ fontFamily: tokens.fontFamilyMonospace }}>{c.number}</Text>
            <ContractStatusBadge status={c.status} />
            <AppLink to={`/organizations/${c.organization.id}?tab=contracts`}>{c.organization.name}</AppLink>
          </>
        }
        actions={
          canWrite &&
          c.status !== 'Ended' && (
            <>
              <Button icon={<Edit20Regular />} onClick={() => navigate(`/contracts/${c.id}/edit`)}>
                {t('common.edit')}
              </Button>
              {(c.status === 'Draft' || c.status === 'Suspended') && (
                <Button appearance="primary" onClick={() => void transition('activate')} disabled={actions.transition.isPending}>
                  {c.status === 'Draft' ? t('contracts.actions.activate') : t('contracts.actions.resume')}
                </Button>
              )}
              {c.status === 'NoticeGiven' && <Button onClick={() => void transition('withdraw-notice')}>{t('contracts.actions.withdrawNotice')}</Button>}
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button {...restoreFocusTarget} icon={<MoreHorizontal20Regular />} aria-label={t('contracts.actions.more')} />
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {c.status === 'Active' && <MenuItem onClick={() => void transition('suspend')}>{t('contracts.actions.suspend')}</MenuItem>}
                    {(c.status === 'Active' || c.status === 'Suspended') && <MenuItem onClick={() => setDialog({ kind: 'notice' })}>{t('contracts.actions.notice')}</MenuItem>}
                    {c.status !== 'Draft' && <MenuItem onClick={() => setDialog({ kind: 'end' })}>{t('contracts.actions.end')}</MenuItem>}
                    {c.status === 'Draft' && (
                      <MenuItem icon={<Delete20Regular />} onClick={() => setDialog({ kind: 'delete' })}>
                        {t('common.delete')}
                      </MenuItem>
                    )}
                  </MenuList>
                </MenuPopover>
              </Menu>
            </>
          )
        }
      />
      <ScrollTabList className={styles.tabs} selectedValue={tab} onTabSelect={(_, d) => setParams(d.value === 'overview' ? {} : { tab: String(d.value) }, { replace: true })}>
        <Tab value="overview">{t('organizations.tabs.overview')}</Tab>
        <Tab value="history">{t('organizations.tabs.history')}</Tab>
      </ScrollTabList>

      {tab === 'history' ? (
        <HistoryList module="contracts" entityType="Contract" entityId={c.id} />
      ) : (
        <div className={styles.stack}>
          <div className={styles.grid}>
            {canSeePrices && (
              <Panel title={t('contracts.sections.value')}>
                <div className={styles.value}>{formatMoney(c.monthlyValue, c.currency)}</div>
                <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                  {t('contracts.valueExplainer')}
                </Text>
              </Panel>
            )}
            <Panel title={t('contracts.sections.term')}>
              <DetailList
                items={[
                  { label: t('contracts.fields.period'), value: `${formatDate(c.startDate)} – ${c.endDate ? formatDate(c.endDate) : t('contracts.untilFurtherNotice')}` },
                  {
                    label: t('contracts.fields.autoRenew'),
                    value: c.autoRenew ? t('contracts.renewsBy', { months: c.renewalTermMonths }) : t('common.no'),
                  },
                  { label: t('contracts.fields.noticePeriodDays'), value: t('contracts.daysCount', { count: c.noticePeriodDays }) },
                  { label: t('contracts.fields.noticeDeadline'), value: c.noticeDeadline && c.status !== 'Ended' ? formatDate(c.noticeDeadline) : null },
                  { label: t('contracts.fields.noticeGivenOn'), value: c.noticeGivenOn ? formatDate(c.noticeGivenOn) : null },
                  { label: t('contracts.fields.renewalCount'), value: c.renewalCount > 0 ? String(c.renewalCount) : null },
                ]}
              />
            </Panel>
            <Panel title={t('contracts.sections.serviceAndBilling')}>
              <DetailList
                items={[
                  { label: t('contracts.fields.type'), value: t(`contracts.types.${c.type}`) },
                  { label: t('contracts.fields.sla'), value: c.slaPolicy?.name },
                  { label: t('contracts.fields.invoicing'), value: `${t(`contracts.frequencies.${c.invoiceFrequency}`)}, ${t(`contracts.timings.${c.invoiceTiming}`).toLowerCase()}` },
                  { label: t('contracts.fields.priceCategory'), value: c.priceCategory ?? t('contracts.defaultCategory') },
                  { label: t('contracts.fields.indexation'), value: c.indexation ? (c.nextIndexationDate ? formatDate(c.nextIndexationDate) : t('common.yes')) : t('common.no') },
                  { label: t('contracts.fields.owner'), value: c.owner?.name },
                  { label: t('contracts.fields.customerReference'), value: c.customerReference },
                ]}
              />
            </Panel>
          </div>

          <Lines contract={c} canWrite={canWrite} onDialog={setDialog} />

          <Panel
            title={t('contracts.hourBanks.title')}
            actions={
              canWrite &&
              c.status !== 'Ended' && (
                <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => setDialog({ kind: 'hourBank' })}>
                  {t('contracts.hourBanks.new')}
                </Button>
              )
            }
          >
            <HourBankList contractId={c.id} />
          </Panel>

          <Panel title={t('customFields.panelTitle')}>
            <CustomFieldsPanel entity="Contract" entityId={c.id} />
          </Panel>

          {c.notes && (
            <Panel title={t('contracts.fields.notes')}>
              <Text style={{ whiteSpace: 'pre-wrap' }}>{c.notes}</Text>
            </Panel>
          )}
        </div>
      )}

      <Dialog open={dialog !== null} onOpenChange={(_, d) => !d.open && close()}>
        <DialogSurface>
          {dialog?.kind === 'line' && <LineForm contract={c} onClose={close} />}
          {dialog?.kind === 'revise' && <ReviseLineForm contract={c} line={dialog.line} onClose={close} />}
          {dialog?.kind === 'notice' && <DateActionForm contract={c} kind="notice" onClose={close} />}
          {dialog?.kind === 'end' && <DateActionForm contract={c} kind="end" onClose={close} />}
          {dialog?.kind === 'endLine' && <DateActionForm contract={c} kind="endLine" line={dialog.line} onClose={close} />}
          {dialog?.kind === 'hourBank' && <HourBankForm organizationId={c.organization.id} contractId={c.id} onClose={close} />}
          {dialog?.kind === 'delete' && (
            <DialogBody>
              <DialogTitle>{t('contracts.deleteTitle', { number: c.number })}</DialogTitle>
              <DialogContent>{t('contracts.deleteBody')}</DialogContent>
              <DialogActions>
                <Button onClick={close}>{t('common.cancel')}</Button>
                <Button appearance="primary" onClick={() => void remove()}>
                  {t('common.delete')}
                </Button>
              </DialogActions>
            </DialogBody>
          )}
        </DialogSurface>
      </Dialog>
    </>
  );
}

function Lines({ contract: c, canWrite, onDialog }: { contract: Contract; canWrite: boolean; onDialog: (d: Dialogs) => void }) {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useContractActions(c.id);
  const canSeePrices = useCan(Permissions.financeRead);
  const [showHistory, setShowHistory] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();
  const today = todayIso();
  const isPast = (l: ContractLine) => l.validTo !== null && l.validTo < today;
  const lines = c.lines.filter((l) => showHistory || !isPast(l));
  const hasHistory = c.lines.some(isPast);
  const editable = canWrite && c.status !== 'Ended';

  const removeLine = async (line: ContractLine) => {
    try {
      await actions.removeLine.mutateAsync(line.id);
      notify(t('contracts.lines.removed'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Panel
      title={t('contracts.lines.title')}
      actions={
        editable && (
          <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => onDialog({ kind: 'line' })}>
            {t('contracts.lines.add')}
          </Button>
        )
      }
    >
      {hasHistory && (
        <div className={styles.lineTools}>
          <Switch label={t('contracts.lines.showHistory')} checked={showHistory} onChange={(_, d) => setShowHistory(d.checked)} />
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <Table aria-label={t('contracts.lines.title')} style={{ minWidth: 760 }}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('catalog.fields.product')}</TableHeaderCell>
              <TableHeaderCell>{t('contracts.fields.quantityModel')}</TableHeaderCell>
              <TableHeaderCell className={catalog.number}>{t('contracts.fields.quantity')}</TableHeaderCell>
              {canSeePrices && <TableHeaderCell className={catalog.number}>{t('contracts.fields.unitPrice')}</TableHeaderCell>}
              {canSeePrices && <TableHeaderCell className={catalog.number}>{t('contracts.fields.amount')}</TableHeaderCell>}
              <TableHeaderCell>{t('contracts.fields.period')}</TableHeaderCell>
              {editable && <TableHeaderCell />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const past = isPast(l);
              return (
                <TableRow key={l.id} className={past ? styles.past : undefined}>
                  <TableCell>
                    <AppLink to={`/catalog/products/${l.productId}`}>{l.productName}</AppLink> {l.version > 1 && <Badge appearance="outline" size="small">v{l.version}</Badge>}
                    <div className={catalog.sku}>{l.description ?? l.sku}</div>
                  </TableCell>
                  <TableCell>
                    {t(`contracts.quantityModels.${l.quantityModel}`)}
                    {l.quantityModel === 'PerAteraDevice' && l.deviceFilter !== 'All' && <div className={catalog.muted}>{t(`contracts.deviceFilters.${l.deviceFilter}`)}</div>}
                  </TableCell>
                  <TableCell className={catalog.number}>
                    {formatNumber(l.quantity)} <span className={catalog.muted}>{t(`catalog.units.${l.unit}`)}</span>
                  </TableCell>
                  {canSeePrices && (
                    <TableCell className={catalog.number}>
                      {formatMoney(l.effectiveUnitPrice)}
                      <div className={catalog.muted}>
                        {l.priceSource ? t(`contracts.priceSources.${l.priceSource}`) : ''}
                        {l.discountPct ? ` · −${formatNumber(l.discountPct)} %` : ''}
                      </div>
                    </TableCell>
                  )}
                  {canSeePrices && (
                    <TableCell className={catalog.number}>
                      {formatMoney(l.amount)}
                      <div className={catalog.muted}>{t(`catalog.periods.${l.billingPeriod}`)}</div>
                    </TableCell>
                  )}
                  <TableCell className="tabular">
                    {formatDate(l.validFrom)} – {l.validTo ? formatDate(l.validTo) : ''}
                  </TableCell>
                  {editable && (
                    <TableCell>
                      {!past && (
                        <Menu>
                          <MenuTrigger disableButtonEnhancement>
                            <Button {...restoreFocusTarget} size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={t('contracts.lines.actionsFor', { name: l.productName })} />
                          </MenuTrigger>
                          <MenuPopover>
                            <MenuList>
                              <MenuItem onClick={() => onDialog({ kind: 'revise', line: l })}>{t('contracts.lines.change')}</MenuItem>
                              {c.status === 'Draft' ? (
                                <MenuItem onClick={() => void removeLine(l)}>{t('contracts.lines.remove')}</MenuItem>
                              ) : (
                                <MenuItem onClick={() => onDialog({ kind: 'endLine', line: l })}>{t('contracts.lines.end')}</MenuItem>
                              )}
                            </MenuList>
                          </MenuPopover>
                        </Menu>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {c.lines.length === 0 && <EmptyState message={t('contracts.lines.empty')} />}
    </Panel>
  );
}
