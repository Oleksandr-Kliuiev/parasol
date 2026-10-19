import { useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Switch,
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
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, formatMoney, formatNumber, parseDecimal } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useSaveSlaPolicy, useSlaPolicies } from './api';
import { useDialogStyles } from './dialogStyles';
import { coverages, type Coverage, type PriorityTarget, type SlaPolicy } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';

const priorities = ['p1', 'p2', 'p3', 'p4'] as const;

const useStyles = makeStyles({
  targets: { display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, alignItems: 'center' },
  head: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** 90 → "1 h 30 min", 2880 → "2 d". Business days are not implied; the coverage says when the clock runs. */
function formatDuration(minutes: number, t: TFunction): string {
  if (minutes % 1440 === 0) return t('contracts.sla.days', { count: minutes / 1440 });
  if (minutes >= 60) return minutes % 60 === 0 ? t('contracts.sla.hours', { count: minutes / 60 }) : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return t('contracts.sla.minutes', { count: minutes });
}

export function SlaPoliciesPage() {
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.contractsWrite);
  const canSeePrices = useCan(Permissions.financeRead);
  const { data = [], error, isPending, refetch } = useSlaPolicies(true);
  const [editing, setEditing] = useState<SlaPolicy | 'new' | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();

  return (
    <>
      <PageHeader
        back={{ to: '/contracts', label: t('contracts.title') }}
        title={t('contracts.sla.title')}
        subtitle={t('contracts.sla.subtitle')}
        actions={
          canWrite && (
            <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setEditing('new')}>
              {t('contracts.sla.new')}
            </Button>
          )
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollTable className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('contracts.sla.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('contracts.fields.name')}</TableHeaderCell>
                <TableHeaderCell>{t('contracts.fields.coverage')}</TableHeaderCell>
                <TableHeaderCell>{t('contracts.sla.p1Response')}</TableHeaderCell>
                <TableHeaderCell className={catalog.number}>{t('contracts.fields.includedHoursPerMonth')}</TableHeaderCell>
                {canSeePrices && <TableHeaderCell className={catalog.number}>{t('contracts.fields.overageRate')}</TableHeaderCell>}
                <TableHeaderCell className={catalog.number}>{t('contracts.sla.contracts')}</TableHeaderCell>
                {canWrite && <TableHeaderCell />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <span className={catalog.name}>{p.name}</span> {!p.isActive && <Badge appearance="outline" color="informative">{t('catalog.inactive')}</Badge>}
                    {p.ateraValue && <div className={catalog.muted}>{t('contracts.sla.ateraValueShort', { value: p.ateraValue })}</div>}
                  </TableCell>
                  <TableCell>{t(`contracts.coverages.${p.coverage}`)}</TableCell>
                  <TableCell>{formatDuration(p.p1.responseMinutes, t)}</TableCell>
                  <TableCell className={catalog.number}>{formatNumber(p.includedHoursPerMonth)}</TableCell>
                  {canSeePrices && <TableCell className={catalog.number}>{formatMoney(p.overageRate)}</TableCell>}
                  <TableCell className={catalog.number}>{p.contractCount}</TableCell>
                  {canWrite && (
                    <TableCell>
                      <Button {...restoreFocusTarget} size="small" appearance="subtle" aria-label={t('contracts.sla.editNamed', { name: p.name })} onClick={() => setEditing(p)}>
                        {t('common.edit')}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && data.length === 0 && <EmptyState message={t('contracts.sla.empty')} />}
        </ScrollTable>
      )}
      <Dialog open={editing !== null} onOpenChange={(_, d) => !d.open && setEditing(null)}>
        <DialogSurface style={{ maxWidth: 680 }}>{editing !== null && <SlaForm existing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}</DialogSurface>
      </Dialog>
    </>
  );
}

const defaultTargets: Record<(typeof priorities)[number], PriorityTarget> = {
  p1: { responseMinutes: 60, resolutionMinutes: 240 },
  p2: { responseMinutes: 240, resolutionMinutes: 960 },
  p3: { responseMinutes: 480, resolutionMinutes: 2880 },
  p4: { responseMinutes: 1440, resolutionMinutes: 7200 },
};

function SlaForm({ existing, onClose }: { existing: SlaPolicy | null; onClose: () => void }) {
  const styles = useStyles();
  const dialog = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const save = useSaveSlaPolicy();
  const canSeePrices = useCan(Permissions.financeRead);
  const [name, setName] = useState(existing?.name ?? '');
  const [coverage, setCoverage] = useState<Coverage>(existing?.coverage ?? 'Business8x5');
  // Targets are edited in hours: that is how service desks talk about them.
  const [targets, setTargets] = useState(() =>
    Object.fromEntries(priorities.map((p) => {
      const target = existing?.[p] ?? defaultTargets[p];
      return [p, { response: String(target.responseMinutes / 60), resolution: String(target.resolutionMinutes / 60) }];
    })) as Record<(typeof priorities)[number], { response: string; resolution: string }>,
  );
  const [included, setIncluded] = useState(String(existing?.includedHoursPerMonth ?? 0));
  const [overage, setOverage] = useState(existing?.overageRate != null ? String(existing.overageRate) : '');
  const [multiplier, setMultiplier] = useState(String(existing?.afterHoursMultiplier ?? 1.5));
  const [ateraValue, setAteraValue] = useState(existing?.ateraValue ?? '');
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);

  const toMinutes = (hours: string) => {
    const value = parseDecimal(hours);
    return value === null || Number.isNaN(value) ? Number.NaN : Math.round(value * 60);
  };
  const target = (p: (typeof priorities)[number]): PriorityTarget => ({ responseMinutes: toMinutes(targets[p].response), resolutionMinutes: toMinutes(targets[p].resolution) });
  const parsed = priorities.map(target);
  const includedValue = parseDecimal(included);
  const overageValue = parseDecimal(overage);
  const multiplierValue = parseDecimal(multiplier);
  const targetsInvalid = parsed.some((p) => !(p.responseMinutes > 0) || !(p.resolutionMinutes >= p.responseMinutes));
  const orderInvalid = parsed.some((p, i) => i > 0 && p.responseMinutes < (parsed[i - 1]?.responseMinutes ?? 0));
  const invalid = !name.trim() || targetsInvalid || orderInvalid || includedValue === null || Number.isNaN(includedValue) || Number.isNaN(overageValue) || multiplierValue === null || Number.isNaN(multiplierValue) || multiplierValue < 1;

  const submit = async () => {
    if (invalid) return;
    try {
      await save.mutateAsync({
        id: existing?.id,
        etag: existing?.etag,
        request: {
          name: name.trim(),
          coverage,
          p1: target('p1'),
          p2: target('p2'),
          p3: target('p3'),
          p4: target('p4'),
          includedHoursPerMonth: includedValue,
          overageRate: canSeePrices ? overageValue : (existing?.overageRate ?? null),
          afterHoursMultiplier: multiplierValue,
          coveredWorkTypes: existing?.coveredWorkTypes ?? null,
          ateraValue: blankToNull(ateraValue),
          isActive,
        },
      });
      notify(t('contracts.sla.saved'));
      onClose();
    } catch {
      // Shown below.
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{existing ? t('contracts.sla.editNamed', { name: existing.name }) : t('contracts.sla.new')}</DialogTitle>
        <DialogContent>
          {save.error && (
            <MessageBar intent="error" className={dialog.error}>
              <MessageBarBody>{errorMessage(save.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={dialog.grid}>
            <Field label={t('contracts.fields.name')} required>
              <Input value={name} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label={t('contracts.fields.coverage')} required>
              <Dropdown value={t(`contracts.coverages.${coverage}`)} selectedOptions={[coverage]} onOptionSelect={(_, d) => setCoverage(d.optionValue as Coverage)}>
                {coverages.map((c) => (
                  <Option key={c} value={c}>
                    {t(`contracts.coverages.${c}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <fieldset className={dialog.wide} style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend style={{ fontWeight: 600, marginBottom: 8 }}>{t('contracts.sla.targets')}</legend>
              <div className={styles.targets}>
                <span />
                <span className={styles.head}>{t('contracts.sla.responseHours')}</span>
                <span className={styles.head}>{t('contracts.sla.resolutionHours')}</span>
                {priorities.map((p) => (
                  <div key={p} style={{ display: 'contents' }}>
                    <strong>{p.toUpperCase()}</strong>
                    <Input
                      inputMode="decimal"
                      aria-label={t('contracts.sla.responseFor', { priority: p.toUpperCase() })}
                      value={targets[p].response}
                      onChange={(_, d) => setTargets((v) => ({ ...v, [p]: { ...v[p], response: d.value } }))}
                    />
                    <Input
                      inputMode="decimal"
                      aria-label={t('contracts.sla.resolutionFor', { priority: p.toUpperCase() })}
                      value={targets[p].resolution}
                      onChange={(_, d) => setTargets((v) => ({ ...v, [p]: { ...v[p], resolution: d.value } }))}
                    />
                  </div>
                ))}
              </div>
              {(targetsInvalid || orderInvalid) && (
                <p style={{ color: tokens.colorPaletteRedForeground1, marginBottom: 0 }}>{orderInvalid ? t('contracts.sla.orderError') : t('contracts.sla.targetError')}</p>
              )}
            </fieldset>
            <Field label={t('contracts.fields.includedHoursPerMonth')}>
              <Input inputMode="decimal" value={included} onChange={(_, d) => setIncluded(d.value)} contentAfter={t('contracts.hoursShort')} />
            </Field>
            {canSeePrices && (
              <Field label={t('contracts.fields.overageRate')}>
                <Input inputMode="decimal" value={overage} onChange={(_, d) => setOverage(d.value)} contentAfter="NOK" />
              </Field>
            )}
            <Field label={t('contracts.fields.afterHoursMultiplier')}>
              <Input inputMode="decimal" value={multiplier} onChange={(_, d) => setMultiplier(d.value)} contentAfter="×" />
            </Field>
            <Field label={t('contracts.fields.ateraValue')} hint={t('contracts.sla.ateraHint')}>
              <Input value={ateraValue} onChange={(_, d) => setAteraValue(d.value)} />
            </Field>
            <Switch label={t('contracts.sla.activeLabel')} checked={isActive} onChange={(_, d) => setIsActive(d.checked)} />
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || save.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
