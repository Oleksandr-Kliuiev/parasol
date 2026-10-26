import { useState } from 'react';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  Text,
  Textarea,
  makeStyles,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { type LegalHoldReason, type Plan, type PlannedErasure, type PrivacyCase, useCaseActions, useHoldActions } from './api';
import { recordLabel } from './recordLabel';

const useStyles = makeStyles({
  fields: { display: 'grid', gap: '16px' },
  record: { fontWeight: 600 },
});

const holdReasons: LegalHoldReason[] = ['LegalClaim', 'AuthorityRequest', 'Bookkeeping', 'Other'];

/** The two confirmations of an erasure case: carrying out the previewed plan, and keeping one record with a legal hold. */
export function ExecuteDialog({ privacyCase, plan, open, onClose }: { privacyCase: PrivacyCase; plan: Plan | undefined; open: boolean; onClose: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useCaseActions(privacyCase.id);
  const [confirmation, setConfirmation] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const matches = confirmation.trim().toUpperCase() === privacyCase.number.toUpperCase();
  const close = () => {
    setConfirmation('');
    setFailure(null);
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!plan || !matches) return;
            actions.execute.mutate(
              { etag: privacyCase.etag, planDigest: plan.digest, confirmation: confirmation.trim() },
              {
                onSuccess: () => {
                  notify(t('privacy.case.execute.done'));
                  close();
                },
                onError: (error) => {
                  const modules = error instanceof ApiError ? (error.problem as { modules?: string[] }).modules : undefined;
                  setFailure(modules?.length ? `${errorMessage(error, t)} (${modules.join(', ')})` : errorMessage(error, t));
                },
              },
            );
          }}
        >
          <DialogBody>
            <DialogTitle>{t('privacy.case.execute.title', { number: privacyCase.number })}</DialogTitle>
            <DialogContent className={styles.fields}>
              <MessageBar intent="warning">
                <MessageBarBody>{t('privacy.case.execute.warning')}</MessageBarBody>
              </MessageBar>
              <Field label={t('privacy.case.execute.confirmation')} required>
                <Input value={confirmation} onChange={(_, d) => setConfirmation(d.value)} autoComplete="off" />
              </Field>
              {failure && (
                <MessageBar intent="error">
                  <MessageBarBody>{failure}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button appearance="primary" type="submit" disabled={!matches || !plan || actions.execute.isPending}>
                {t('privacy.case.execute.submit')}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

export function HoldDialog({ record, onClose, onPlaced }: { record: PlannedErasure | null; onClose: () => void; onPlaced: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useHoldActions();
  const [reason, setReason] = useState<LegalHoldReason>('LegalClaim');
  const [explanation, setExplanation] = useState('');
  const [until, setUntil] = useState('');
  const shown = useKeptWhileClosing(record);
  const close = () => {
    setExplanation('');
    setUntil('');
    onClose();
  };
  return (
    <Dialog open={record !== null} onOpenChange={(_, d) => !d.open && close()}>
      <DialogSurface>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!record || !explanation.trim() || !until) return;
            actions.place.mutate(
              { module: record.record.module, entityType: record.record.entityType, entityId: record.record.entityId, reason, explanation: explanation.trim(), until },
              {
                onSuccess: () => {
                  setExplanation('');
                  setUntil('');
                  onPlaced();
                },
                onError: (error) => notify(t('errors.generic'), 'error', errorMessage(error, t)),
              },
            );
          }}
        >
          <DialogBody>
            <DialogTitle>{t('privacy.holds.placeTitle')}</DialogTitle>
            <DialogContent className={styles.fields}>
              {shown && <Text block className={styles.record}>{recordLabel(t, shown.record.module, shown.record.entityType, shown.record.entityId)}</Text>}
              <Field label={t('privacy.holds.reason')}>
                <Select value={reason} onChange={(_, d) => setReason(d.value as LegalHoldReason)}>
                  {holdReasons.map((r) => (
                    <option key={r} value={r}>
                      {t(`privacy.holds.reasons.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('privacy.holds.explanation')} required hint={t('privacy.holds.explanationHint')}>
                <Textarea value={explanation} onChange={(_, d) => setExplanation(d.value)} maxLength={1000} />
              </Field>
              <Field label={t('privacy.holds.until')} required hint={t('privacy.holds.untilHint')}>
                <Input type="date" value={until} onChange={(_, d) => setUntil(d.value)} />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button appearance="primary" type="submit" disabled={!explanation.trim() || !until || actions.place.isPending}>
                {t('privacy.holds.place')}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
