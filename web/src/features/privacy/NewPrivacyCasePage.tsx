import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Input, Radio, RadioGroup, Select, Text, Textarea, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { todayIso } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { type DataSubjectKind, type PrivacyCaseKind, type RequestChannel, useOpenCase } from './api';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '560px' },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS },
});

const channels: RequestChannel[] = ['Email', 'Letter', 'Phone', 'InPerson', 'Other'];
const subjectKinds: DataSubjectKind[] = ['Contact', 'Lead'];
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens a data subject request (DEV-11) for the contact or lead the user came from. The person's name travels in the
 * navigation state, never in the address, so it does not end up in the browser history or a proxy log.
 */
export function NewPrivacyCasePage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const allowed = useCan(Permissions.privacyManage);
  const open = useOpenCase();
  const [kind, setKind] = useState<PrivacyCaseKind>(params.get('kind') === 'Erasure' ? 'Erasure' : 'Access');
  const [channel, setChannel] = useState<RequestChannel>('Email');
  const [receivedOn, setReceivedOn] = useState(todayIso());
  const [note, setNote] = useState('');

  const subjectKind = params.get('subjectKind') as DataSubjectKind | null;
  const subjectId = params.get('subjectId') ?? '';
  const state = location.state as { subjectName?: string; back?: string } | null;
  const subjectName = state?.subjectName;
  if (!allowed || !subjectKind || !subjectKinds.includes(subjectKind) || !guid.test(subjectId)) return <NotFoundPage />;

  const today = todayIso();
  const back = state?.back ?? (subjectKind === 'Contact' ? `/contacts/${subjectId}` : '/sales/leads');
  return (
    <>
      <PageHeader title={t('privacy.new.title')} back={{ to: back, label: t('common.back') }} />
      <Panel title={t(`privacy.subjects.${subjectKind}`)}>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            open.mutate(
              {
                kind,
                subjectKind,
                subjectId,
                channel,
                // Noon UTC is the same calendar day in Oslo all year; a request received today is stamped by the server.
                receivedAt: receivedOn && receivedOn !== today ? `${receivedOn}T12:00:00Z` : null,
                note: note.trim() || null,
              },
              {
                onSuccess: (created) => navigate(`/admin/privacy/cases/${created.id}`),
                onError: (error) => notify(t('errors.generic'), 'error', errorMessage(error, t)),
              },
            );
          }}
        >
          <Text>{subjectName ?? t('privacy.new.subjectUnnamed')}</Text>
          <Field label={t('privacy.new.kind')} required>
            <RadioGroup value={kind} onChange={(_, d) => setKind(d.value as PrivacyCaseKind)}>
              <Radio value="Access" label={t('privacy.new.kinds.Access')} />
              <Radio value="Erasure" label={t('privacy.new.kinds.Erasure')} />
            </RadioGroup>
          </Field>
          <Field label={t('privacy.case.channel')}>
            <Select value={channel} onChange={(_, d) => setChannel(d.value as RequestChannel)}>
              {channels.map((c) => (
                <option key={c} value={c}>
                  {t(`privacy.channels.${c}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('privacy.case.received')} hint={t('privacy.new.receivedHint')}>
            <Input type="date" value={receivedOn} max={today} onChange={(_, d) => setReceivedOn(d.value)} />
          </Field>
          <Field label={t('privacy.case.note')} hint={t('privacy.new.noteHint')}>
            <Textarea value={note} onChange={(_, d) => setNote(d.value)} maxLength={500} />
          </Field>
          <div className={styles.actions}>
            <Button appearance="primary" type="submit" disabled={open.isPending}>
              {t('privacy.new.submit')}
            </Button>
            <Button onClick={() => navigate(back)}>{t('common.cancel')}</Button>
          </div>
        </form>
      </Panel>
    </>
  );
}
