import { useState } from 'react';
import {
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
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { UserPicker } from '../../shared/components/UserPicker';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, parseDecimal, todayIso } from '../../shared/utils/format';
import { useDialogStyles } from '../contracts/dialogStyles';
import { OrganizationPicker } from '../contracts/OrganizationPicker';
import type { Ref as OrganizationRef } from '../contracts/types';
import type { UserRef } from '../../api/types';
import { useOpportunityActions, useStages } from './api';
import { businessLines, type BusinessLine, type Opportunity } from './types';

interface OpportunityDialogProps {
  open: boolean;
  onClose: () => void;
  opportunity?: Opportunity;
  organization?: OrganizationRef | null;
  stageId?: string;
}

export function OpportunityDialog({ open, onClose, ...props }: OpportunityDialogProps) {
  // The form mounts with the surface, once per opening, and keeps its deal while the dialog leaves.
  const opportunity = useKeptWhileClosing(props.opportunity, open);
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface><OpportunityForm onClose={onClose} {...props} opportunity={opportunity} /></DialogSurface>
    </Dialog>
  );
}

function OpportunityForm({ opportunity, organization, stageId, onClose }: Omit<OpportunityDialogProps, 'open'>) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useOpportunityActions();
  const stages = useStages();
  const canSeeMoney = useCan(Permissions.financeRead);
  const [org, setOrg] = useState<OrganizationRef | null>(
    opportunity ? { id: opportunity.organization.id, name: opportunity.organization.name } : (organization ?? null),
  );
  const [name, setName] = useState(opportunity?.name ?? '');
  const [businessLine, setBusinessLine] = useState<BusinessLine>(opportunity?.businessLine ?? 'Msp');
  const [stage, setStage] = useState(opportunity?.stageId ?? stageId ?? '');
  const [probability, setProbability] = useState(opportunity ? String(opportunity.probability) : '');
  const [closeDate, setCloseDate] = useState(opportunity?.expectedCloseDate ?? todayIso());
  const [oneOff, setOneOff] = useState(opportunity?.oneOffAmount != null ? String(opportunity.oneOffAmount) : '0');
  const [mrr, setMrr] = useState(opportunity?.mrr != null ? String(opportunity.mrr) : '0');
  const [term, setTerm] = useState(String(opportunity?.termMonths ?? 12));
  const [owner, setOwner] = useState<UserRef | null>(opportunity?.owner ? { id: opportunity.owner.id, displayName: opportunity.owner.name } : null);
  const [source, setSource] = useState(opportunity?.source ?? '');
  const [competitor, setCompetitor] = useState(opportunity?.competitor ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const openStages = (stages.data ?? []).filter((s) => !s.isWon && !s.isLost);
  const selectedStage = openStages.find((s) => s.id === stage) ?? openStages[0];
  const mutation = opportunity ? actions.update : actions.create;
  const probabilityValue = probability.trim() === '' ? null : Number(probability);
  const invalid = !org || !name.trim() || !selectedStage || (probabilityValue !== null && (Number.isNaN(probabilityValue) || probabilityValue < 0 || probabilityValue > 100));

  const submit = async () => {
    if (invalid) return;
    const request = {
      organizationId: org.id,
      contactId: opportunity?.contactId ?? null,
      name: name.trim(),
      businessLine,
      stageId: selectedStage.id,
      probability: probabilityValue,
      expectedCloseDate: closeDate,
      oneOffAmount: canSeeMoney ? (parseDecimal(oneOff) ?? 0) : (opportunity?.oneOffAmount ?? 0),
      mrr: canSeeMoney ? (parseDecimal(mrr) ?? 0) : (opportunity?.mrr ?? 0),
      termMonths: Number(term) || 0,
      ownerId: owner?.id ?? null,
      source: blankToNull(source),
      competitor: blankToNull(competitor),
    };
    try {
      if (opportunity) await actions.update.mutateAsync({ id: opportunity.id, request, etag: opportunity.etag });
      else await actions.create.mutateAsync(request);
      notify(opportunity ? t('opportunities.saved') : t('opportunities.created'));
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) setErrors(error.fieldErrors);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{opportunity ? t('opportunities.editTitle') : t('opportunities.new')}</DialogTitle>
        <DialogContent>
          {mutation.error && !(mutation.error instanceof ApiError && mutation.error.status === 400) && (
            <MessageBar intent="error" className={styles.error}>
              <MessageBarBody>{errorMessage(mutation.error, t)}</MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.grid}>
            <Field label={t('opportunities.fields.organization')} required className={styles.wide} validationMessage={errors.organizationId}>
              <OrganizationPicker value={org} onChange={setOrg} disabled={Boolean(opportunity)} />
            </Field>
            <Field label={t('opportunities.fields.name')} required className={styles.wide} validationMessage={errors.name}>
              <Input value={name} onChange={(_, d) => setName(d.value)} />
            </Field>
            <Field label={t('opportunities.fields.businessLine')} required>
              <Dropdown value={t(`opportunities.businessLines.${businessLine}`)} selectedOptions={[businessLine]} onOptionSelect={(_, d) => setBusinessLine(d.optionValue as BusinessLine)}>
                {businessLines.map((value) => (
                  <Option key={value} value={value}>
                    {t(`opportunities.businessLines.${value}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('opportunities.fields.stage')} required>
              <Dropdown value={selectedStage?.name ?? ''} selectedOptions={selectedStage ? [selectedStage.id] : []} onOptionSelect={(_, d) => setStage(d.optionValue ?? '')}>
                {openStages.map((value) => (
                  <Option key={value.id} value={value.id} text={value.name}>
                    {value.name} · {value.probability} %
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('opportunities.fields.probability')} hint={t('opportunities.probabilityHint', { probability: selectedStage?.probability ?? 0 })}>
              <Input inputMode="numeric" value={probability} onChange={(_, d) => setProbability(d.value)} contentAfter="%" />
            </Field>
            <Field label={t('opportunities.fields.expectedCloseDate')} required validationMessage={errors.expectedCloseDate}>
              <Input type="date" value={closeDate} onChange={(_, d) => setCloseDate(d.value)} />
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
            <Field label={t('opportunities.fields.termMonths')} hint={t('opportunities.termHint')}>
              <Input type="number" min={0} max={120} value={term} onChange={(_, d) => setTerm(d.value)} />
            </Field>
            <Field label={t('opportunities.fields.owner')}>
              <UserPicker value={owner} onChange={setOwner} />
            </Field>
            <Field label={t('opportunities.fields.source')}>
              <Input value={source} onChange={(_, d) => setSource(d.value)} />
            </Field>
            <Field label={t('opportunities.fields.competitor')}>
              <Input value={competitor} onChange={(_, d) => setCompetitor(d.value)} />
            </Field>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || mutation.isPending}>
            {opportunity ? t('common.save') : t('common.create')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}

/** Asks for the reason a deal was lost (BR-SAL-02). */
export function LoseDialog({ open, opportunity, stageId, onClose }: { open: boolean; opportunity: Opportunity | null; stageId: string; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useOpportunityActions();
  const [reason, setReason] = useState('');
  const reasons = ['Price', 'Competitor', 'NoDecision', 'Timing', 'Other'];
  const shown = useKeptWhileClosing(opportunity, open);

  const submit = async () => {
    if (!opportunity || !reason) return;
    try {
      await actions.move.mutateAsync({ id: opportunity.id, stageId, lostReason: t(`opportunities.lostReasons.${reason}`) });
      notify(t('opportunities.lost'));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <DialogBody>
            <DialogTitle>{t('opportunities.loseTitle', { name: shown?.name ?? '' })}</DialogTitle>
            <DialogContent>
              <Field label={t('opportunities.fields.lostReason')} required className={styles.wide}>
                <Dropdown value={reason ? t(`opportunities.lostReasons.${reason}`) : ''} selectedOptions={reason ? [reason] : []} onOptionSelect={(_, d) => setReason(d.optionValue ?? '')}>
                  {reasons.map((value) => (
                    <Option key={value} value={value}>
                      {t(`opportunities.lostReasons.${value}`)}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
            </DialogContent>
            <DialogActions>
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button appearance="primary" type="submit" disabled={!reason || actions.move.isPending}>
                {t('opportunities.markLost')}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
