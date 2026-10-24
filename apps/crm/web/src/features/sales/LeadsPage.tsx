import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Button,
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
  Tooltip,
  makeStyles,
  mergeClasses,
  useRestoreFocusTarget,
  type BadgeProps,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { RecordCell } from '../organizations/RecordCell';
import { Add20Regular, ContactCard24Regular, Edit20Regular, PersonArrowRight20Regular, Prohibited20Regular, ShieldPerson20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { UserPicker } from '../../shared/components/UserPicker';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, formatDate, parseDecimal, todayIso } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { FilterChips, FilterField, Toolbar } from '../../shared/components/Toolbar';
import { badgeDot, useCatalogStyles } from '../catalog/styles';
import { useDialogStyles } from '../contracts/dialogStyles';
import { formatOrgNumber, isValidOrgNumber } from '../../shared/utils/orgNumber';
import type { UserRef } from '../../api/types';
import { useLeadActions, useLeads, useStages } from './api';
import { leadStatuses, type Lead, type LeadStatus } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  // Quiet icon buttons: each is named in full for screen readers (tooltip label or aria-label) and shows a tooltip.
  actions: { display: 'flex', alignItems: 'center', gap: '2px', justifyContent: 'flex-end', whiteSpace: 'nowrap' },
  // The fixed columns (content plus 24 px padding) and room for the company: narrower screens scroll the card.
  table: { minWidth: '1060px' },
  person: { fontWeight: 500, fontSize: '13px' },
  // A link in the small line under a name still gets a 24 px tall target (WCAG 2.5.8).
  metaLink: { display: 'inline-flex', alignItems: 'center', minHeight: '24px' },
});

const leadColor: Record<LeadStatus, NonNullable<BadgeProps['color']>> = { New: 'brand', Qualified: 'informative', Disqualified: 'subtle', Converted: 'success' };

/** Enquiries before they are customers; converting one creates the organization, its contact and optionally a deal (FR-SAL-01). */
export function LeadsPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.salesWrite);
  const canPrivacy = useCan(Permissions.privacyManage);
  const navigate = useNavigate();
  const [status, setStatus] = useState<LeadStatus | null>('New');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim());
  const leads = useLeads({ status, mine, search: debounced });
  const { items: data, error, isPending, refetch } = leads;
  // While another search or filter is read, the previous rows stay where they are, so a click on one still lands. They are not its
  // answer: the end of the list says it is loading, and no count or empty answer is claimed for them.
  const stale = leads.isPlaceholderData;
  const [dialog, setDialog] = useState<{ kind: 'edit' | 'convert' | 'disqualify'; lead?: Lead } | null>(null);
  const shown = useKeptWhileClosing(dialog);
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
      <Toolbar label={t('leads.filterLabel')}>
        <FilterField kind="search" label={t('leads.search')}>
          <SearchBox id="leads-search" value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('leads.search')} />
        </FilterField>
        <FilterChips<LeadStatus | ''>
          label={t('leads.fields.status')}
          value={status ?? ''}
          onChange={(value) => setStatus(value || null)}
          options={[
            { value: '', label: t('common.all') },
            ...leadStatuses.map((value) => ({ value, label: t(`leads.statuses.${value}`), dot: badgeDot[leadColor[value]] })),
          ]}
        />
        <Switch className={catalog.toggle} label={t('leads.mine')} checked={mine} onChange={(_, d) => setMine(d.checked)} />
      </Toolbar>

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollTable className={catalog.tableWrap}>
          <Table className={mergeClasses(catalog.table, styles.table)} aria-label={t('leads.title')} aria-busy={stale || undefined}>
            <TableHeader>
              <TableRow>
                {/* Content widths: every cell adds 12 px of padding on each side; the company takes the rest. */}
                <TableHeaderCell>{t('leads.fields.company')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 186 }}>{t('leads.fields.contact')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 96 }}>{t('leads.fields.source')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 106 }}>{t('leads.fields.status')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 136 }}>{t('leads.fields.owner')}</TableHeaderCell>
                <TableHeaderCell style={{ width: 86 }}>{t('leads.fields.created')}</TableHeaderCell>
                {(canWrite || canPrivacy) && <TableHeaderCell style={{ width: 132 }} />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell>
                    <RecordCell
                      avatarName={lead.companyName}
                      name={<span className={catalog.name}>{lead.companyName}</span>}
                      meta={[
                        lead.orgNumber && formatOrgNumber(lead.orgNumber),
                        lead.organizationId && <AppLink to={`/organizations/${lead.organizationId}`} className={styles.metaLink}>{t('leads.openOrganization')}</AppLink>,
                      ]}
                    />
                  </TableCell>
                  <TableCell>
                    {(lead.contactName || lead.email) && (
                      <RecordCell avatarName={lead.contactName ?? lead.email ?? ''} size={28} name={<span className={styles.person}>{lead.contactName}</span>} meta={[lead.email]} />
                    )}
                  </TableCell>
                  <TableCell>{lead.source}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={leadColor[lead.status]}>
                      {t(`leads.statuses.${lead.status}`)}
                    </Badge>
                    {lead.disqualifyReason && <div className={catalog.muted}>{lead.disqualifyReason}</div>}
                  </TableCell>
                  <TableCell>{lead.owner && <RecordCell avatarName={lead.owner.name} size={28} name={<span className={styles.person}>{lead.owner.name}</span>} />}</TableCell>
                  <TableCell className="tabular">{formatDate(lead.createdAt)}</TableCell>
                  {(canWrite || canPrivacy) && (
                    <TableCell>
                      <span className={styles.actions}>
                        {canWrite && lead.status !== 'Converted' && (
                          <>
                            <Tooltip content={t('leads.convert')} relationship="label">
                              <Button {...restoreFocusTarget} size="small" appearance="subtle" icon={<PersonArrowRight20Regular />} onClick={() => setDialog({ kind: 'convert', lead })} />
                            </Tooltip>
                            <Tooltip content={t('common.edit')} relationship="description">
                              <Button {...restoreFocusTarget} size="small" appearance="subtle" icon={<Edit20Regular />} onClick={() => setDialog({ kind: 'edit', lead })}
                                aria-label={t('leads.editNamed', { name: lead.companyName })} />
                            </Tooltip>
                            <Tooltip content={t('leads.disqualify')} relationship="description">
                              <Button {...restoreFocusTarget} size="small" appearance="subtle" icon={<Prohibited20Regular />} onClick={() => setDialog({ kind: 'disqualify', lead })}
                                aria-label={t('leads.disqualifyNamed', { name: lead.companyName })} />
                            </Tooltip>
                          </>
                        )}
                        {canPrivacy && (lead.contactName || lead.email) && (
                          // DEV-11: the person's name goes along in the navigation state, not in the address.
                          <Tooltip content={t('privacy.new.leadButton')} relationship="description">
                            <Button size="small" appearance="subtle" icon={<ShieldPerson20Regular />}
                              onClick={() => navigate(`/admin/privacy/new?subjectKind=Lead&subjectId=${lead.id}`, { state: { subjectName: lead.contactName ?? lead.companyName } })}
                              aria-label={t('privacy.new.leadButtonNamed', { name: lead.contactName ?? lead.companyName })} />
                          </Tooltip>
                        )}
                      </span>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && !stale && data.length === 0 && <EmptyState icon={<ContactCard24Regular />} message={t('leads.empty')} />}
          <ListFooter shown={data.length} total={leads.total} hasMore={leads.hasNextPage} loading={leads.isFetchingNextPage} onMore={() => void leads.fetchNextPage()}
            stale={stale} />
        </ScrollTable>
      )}

      <Dialog open={dialog !== null} onOpenChange={(_, d) => !d.open && setDialog(null)}>
        <DialogSurface>
          {shown?.kind === 'edit' && <LeadForm lead={shown.lead} onClose={() => setDialog(null)} />}
          {shown?.kind === 'convert' && <ConvertForm lead={shown.lead!} onClose={() => setDialog(null)} />}
          {shown?.kind === 'disqualify' && <DisqualifyForm lead={shown.lead!} onClose={() => setDialog(null)} />}
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
          <p className={styles.lead}>{t('leads.convertBody')}</p>
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
