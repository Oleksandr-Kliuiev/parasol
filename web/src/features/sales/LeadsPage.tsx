import { useState } from 'react';
import { useNavigate } from 'react-router';
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
  SearchBox,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Textarea,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, formatDate, parseDecimal, todayIso } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { useCatalogStyles } from '../catalog/styles';
import { useDialogStyles } from '../contracts/dialogStyles';
import { formatOrgNumber, isValidOrgNumber } from '../../shared/utils/orgNumber';
import type { UserRef } from '../../api/types';
import { useLeadActions, useLeads, useStages } from './api';
import { leadStatuses, type Lead, type LeadStatus } from './types';

const useStyles = makeStyles({
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS, justifyContent: 'flex-end' },
});

/** Enquiries before they are customers; converting one creates the organization, its contact and optionally a deal (FR-SAL-01). */
export function LeadsPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.salesWrite);
  const [status, setStatus] = useState<LeadStatus | null>('New');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim());
  const { data = [], error, isPending, refetch } = useLeads({ status, mine, search: debounced });
  const [dialog, setDialog] = useState<{ kind: 'edit' | 'convert' | 'disqualify'; lead?: Lead } | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();

  return (
    <>
      <PageHeader
        title={t('leads.title')}
        subtitle={t('leads.subtitle')}
        actions={
          canWrite && (
            <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setDialog({ kind: 'edit' })}>
              {t('leads.new')}
            </Button>
          )
        }
      />
      <div className={catalog.filters}>
        <SearchBox
          id="leads-search"
          className={catalog.search}
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          placeholder={t('leads.search')}
          aria-label={t('leads.search')}
        />
        <Field label={t('leads.fields.status')}>
          <Dropdown
            value={status ? t(`leads.statuses.${status}`) : t('common.all')}
            selectedOptions={[status ?? '']}
            onOptionSelect={(_, d) => setStatus((d.optionValue as LeadStatus) || null)}
          >
            <Option value="">{t('common.all')}</Option>
            {leadStatuses.map((value) => (
              <Option key={value} value={value}>
                {t(`leads.statuses.${value}`)}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Switch label={t('leads.mine')} checked={mine} onChange={(_, d) => setMine(d.checked)} />
      </div>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('leads.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('leads.fields.company')}</TableHeaderCell>
                <TableHeaderCell>{t('leads.fields.contact')}</TableHeaderCell>
                <TableHeaderCell>{t('leads.fields.source')}</TableHeaderCell>
                <TableHeaderCell>{t('leads.fields.status')}</TableHeaderCell>
                <TableHeaderCell>{t('leads.fields.owner')}</TableHeaderCell>
                <TableHeaderCell>{t('leads.fields.created')}</TableHeaderCell>
                {canWrite && <TableHeaderCell />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell>
                    <span className={catalog.name}>{lead.companyName}</span>
                    {lead.orgNumber && <div className={catalog.sku}>{formatOrgNumber(lead.orgNumber)}</div>}
                    {lead.organizationId && (
                      <div className={catalog.sku}>
                        <AppLink to={`/organizations/${lead.organizationId}`}>{t('leads.openOrganization')}</AppLink>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {lead.contactName}
                    {lead.email && <div className={catalog.sku}>{lead.email}</div>}
                  </TableCell>
                  <TableCell>{lead.source}</TableCell>
                  <TableCell>
                    <Badge appearance={lead.status === 'New' ? 'tint' : 'outline'} color={lead.status === 'Converted' ? 'success' : lead.status === 'Disqualified' ? 'subtle' : 'brand'}>
                      {t(`leads.statuses.${lead.status}`)}
                    </Badge>
                    {lead.disqualifyReason && <div className={catalog.sku}>{lead.disqualifyReason}</div>}
                  </TableCell>
                  <TableCell>{lead.owner?.name}</TableCell>
                  <TableCell className="tabular">{formatDate(lead.createdAt)}</TableCell>
                  {canWrite && (
                    <TableCell>
                      <span className={styles.actions}>
                        {lead.status !== 'Converted' && (
                          <>
                            <Button {...restoreFocusTarget} size="small" onClick={() => setDialog({ kind: 'convert', lead })}>
                              {t('leads.convert')}
                            </Button>
                            <Button {...restoreFocusTarget} size="small" appearance="subtle" onClick={() => setDialog({ kind: 'edit', lead })}
                              aria-label={t('leads.editNamed', { name: lead.companyName })}>
                              {t('common.edit')}
                            </Button>
                            <Button {...restoreFocusTarget} size="small" appearance="subtle" onClick={() => setDialog({ kind: 'disqualify', lead })}
                              aria-label={t('leads.disqualifyNamed', { name: lead.companyName })}>
                              {t('leads.disqualify')}
                            </Button>
                          </>
                        )}
                      </span>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && data.length === 0 && <EmptyState message={t('leads.empty')} />}
        </div>
      )}

      <Dialog open={dialog !== null} onOpenChange={(_, d) => !d.open && setDialog(null)}>
        <DialogSurface>
          {dialog?.kind === 'edit' && <LeadForm lead={dialog.lead} onClose={() => setDialog(null)} />}
          {dialog?.kind === 'convert' && <ConvertForm lead={dialog.lead!} onClose={() => setDialog(null)} />}
          {dialog?.kind === 'disqualify' && <DisqualifyForm lead={dialog.lead!} onClose={() => setDialog(null)} />}
        </DialogSurface>
      </Dialog>
    </>
  );
}

function LeadForm({ lead, onClose }: { lead?: Lead; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useLeadActions();
  const [values, setValues] = useState({
    companyName: lead?.companyName ?? '',
    orgNumber: lead?.orgNumber ? formatOrgNumber(lead.orgNumber) : '',
    contactName: lead?.contactName ?? '',
    email: lead?.email ?? '',
    phone: lead?.phone ?? '',
    source: lead?.source ?? '',
    notes: lead?.notes ?? '',
  });
  const [owner, setOwner] = useState<UserRef | null>(lead?.owner ? { id: lead.owner.id, displayName: lead.owner.name } : null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mutation = lead ? actions.update : actions.create;
  const orgNumberInvalid = values.orgNumber.trim() !== '' && !isValidOrgNumber(values.orgNumber);
  const invalid = !values.companyName.trim() || orgNumberInvalid;

  const submit = async () => {
    if (invalid) return;
    const request = {
      companyName: values.companyName.trim(),
      orgNumber: blankToNull(values.orgNumber)?.replace(/\s/g, '') ?? null,
      contactName: blankToNull(values.contactName),
      email: blankToNull(values.email),
      phone: blankToNull(values.phone),
      source: blankToNull(values.source),
      ownerId: owner?.id ?? null,
      notes: blankToNull(values.notes),
    };
    try {
      if (lead) await actions.update.mutateAsync({ id: lead.id, request, etag: lead.etag });
      else await actions.create.mutateAsync(request);
      notify(lead ? t('leads.saved') : t('leads.created'));
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) setErrors(error.fieldErrors);
    }
  };

  const text = (key: keyof typeof values, wide = false) => (
    <Field label={t(`leads.fields.${key}`)} className={wide ? styles.wide : undefined} validationMessage={errors[key]} required={key === 'companyName'}>
      <Input value={values[key]} onChange={(_, d) => setValues((v) => ({ ...v, [key]: d.value }))} />
    </Field>
  );

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{lead ? t('leads.editTitle') : t('leads.new')}</DialogTitle>
        <DialogContent>
          {mutation.error && !(mutation.error instanceof ApiError && mutation.error.status === 400) && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{errorMessage(mutation.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.grid}>
            {text('companyName', true)}
            <Field label={t('leads.fields.orgNumber')} validationState={orgNumberInvalid ? 'error' : 'none'} validationMessage={orgNumberInvalid ? t('organizations.form.invalidOrgNumber') : errors.orgNumber}>
              <Input inputMode="numeric" value={values.orgNumber} onChange={(_, d) => setValues((v) => ({ ...v, orgNumber: d.value }))} />
            </Field>
            {text('source')}
            {text('contactName')}
            {text('email')}
            {text('phone')}
            <Field label={t('leads.fields.owner')}>
              <UserPicker value={owner} onChange={setOwner} />
            </Field>
            <Field label={t('leads.fields.notes')} className={styles.wide}>
              <Textarea value={values.notes} onChange={(_, d) => setValues((v) => ({ ...v, notes: d.value }))} resize="vertical" />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || mutation.isPending}>
            {lead ? t('common.save') : t('common.create')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

function ConvertForm({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const navigate = useNavigate();
  const actions = useLeadActions();
  const stages = useStages();
  const canSeeMoney = useCan(Permissions.financeRead);
  const [createOpportunity, setCreateOpportunity] = useState(true);
  const [name, setName] = useState(lead.companyName);
  const [stageId, setStageId] = useState('');
  const [closeDate, setCloseDate] = useState(() => {
    const date = new Date();
    date.setMonth(date.getMonth() + 1);
    return date.toISOString().slice(0, 10);
  });
  const [oneOff, setOneOff] = useState('0');
  const [mrr, setMrr] = useState('0');
  const [term, setTerm] = useState('12');
  const openStages = (stages.data ?? []).filter((s) => !s.isWon && !s.isLost);
  const selectedStage = openStages.find((s) => s.id === stageId) ?? openStages[0];

  const submit = async () => {
    try {
      const result = await actions.convert.mutateAsync({
        id: lead.id,
        createOpportunity,
        opportunityName: createOpportunity ? name.trim() : null,
        stageId: createOpportunity ? (selectedStage?.id ?? null) : null,
        expectedCloseDate: createOpportunity ? closeDate : null,
        oneOffAmount: createOpportunity ? (parseDecimal(oneOff) ?? 0) : null,
        mrr: createOpportunity ? (parseDecimal(mrr) ?? 0) : null,
        termMonths: createOpportunity ? Number(term) : null,
      });
      notify(t('leads.converted'));
      onClose();
      if (result.data.opportunityId) navigate(`/sales/opportunities/${result.data.opportunityId}`);
      else if (result.data.organizationId) navigate(`/organizations/${result.data.organizationId}`);
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('leads.convertTitle', { name: lead.companyName })}</DialogTitle>
        <DialogContent>
          {actions.convert.error && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{errorMessage(actions.convert.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <p style={{ marginTop: 0 }}>{t('leads.convertBody')}</p>
          <div className={styles.grid}>
            <Switch className={styles.wide} label={t('leads.createOpportunity')} checked={createOpportunity} onChange={(_, d) => setCreateOpportunity(d.checked)} />
            {createOpportunity && (
              <>
                <Field label={t('opportunities.fields.name')} required className={styles.wide}>
                  <Input value={name} onChange={(_, d) => setName(d.value)} />
                </Field>
                <Field label={t('opportunities.fields.stage')}>
                  <Dropdown value={selectedStage?.name ?? ''} selectedOptions={selectedStage ? [selectedStage.id] : []} onOptionSelect={(_, d) => setStageId(d.optionValue ?? '')}>
                    {openStages.map((stage) => (
                      <Option key={stage.id} value={stage.id}>
                        {stage.name}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label={t('opportunities.fields.expectedCloseDate')} required>
                  <Input type="date" value={closeDate} min={todayIso()} onChange={(_, d) => setCloseDate(d.value)} />
                </Field>
                {canSeeMoney && (
                  <>
                    <Field label={t('opportunities.fields.oneOffAmount')}>
                      <Input inputMode="decimal" value={oneOff} onChange={(_, d) => setOneOff(d.value)} contentAfter="NOK" />
                    </Field>
                    <Field label={t('opportunities.fields.mrr')}>
                      <Input inputMode="decimal" value={mrr} onChange={(_, d) => setMrr(d.value)} contentAfter="NOK" />
                    </Field>
                  </>
                )}
                <Field label={t('opportunities.fields.termMonths')}>
                  <Input type="number" min={0} max={120} value={term} onChange={(_, d) => setTerm(d.value)} />
                </Field>
              </>
            )}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={actions.convert.isPending || (createOpportunity && !name.trim())}>
            {t('leads.convert')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

function DisqualifyForm({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useLeadActions();
  const [reason, setReason] = useState('');

  const submit = async () => {
    try {
      await actions.disqualify.mutateAsync({ id: lead.id, reason: reason.trim() });
      notify(t('leads.disqualified'));
      onClose();
    } catch {
      // Shown in the dialog.
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('leads.disqualifyTitle', { name: lead.companyName })}</DialogTitle>
        <DialogContent>
          {actions.disqualify.error && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{errorMessage(actions.disqualify.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <Field label={t('leads.fields.reason')} required>
            <Input value={reason} onChange={(_, d) => setReason(d.value)} />
          </Field>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={!reason.trim() || actions.disqualify.isPending}>
            {t('leads.disqualify')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
