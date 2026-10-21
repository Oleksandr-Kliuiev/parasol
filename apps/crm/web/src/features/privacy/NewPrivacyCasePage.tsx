import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button, Field, Input, Radio, RadioGroup, Select, Textarea, makeStyles } from '@fluentui/react-components';
import { PersonInfo16Regular, PersonInfo24Regular } from '@fluentui/react-icons';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { todayIso } from '../../shared/utils/format';
import { ForbiddenPage } from '../errors/ForbiddenPage';
import { PersonCell } from '../admin/settingsUi';
import { type DataSubjectKind, type PrivacyCaseKind, type RequestChannel, useOpenCase } from './api';

const useStyles = makeStyles({
  panel: { maxWidth: '600px' },
  form: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 },
  // The person the request is about, in a well above the form.
  subject: { paddingTop: '10px', paddingBottom: '10px', paddingLeft: '12px', paddingRight: '12px', borderRadius: '14px', backgroundColor: h.well },
  // The buttons of the form at its foot, on the right: Cancel, then the primary action last.
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '10px', paddingTop: '14px', borderTop: `1px solid ${h.line}` },
  startLinks: { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '8px 20px', fontWeight: 600 },
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
  if (!allowed) return <ForbiddenPage />;
  // Reached without a person (a bookmark, a typed address): say where a request starts instead of "page not found".
  if (!subjectKind || !subjectKinds.includes(subjectKind) || !guid.test(subjectId)) return (
    <>
      <PageHeader title={t('privacy.new.title')} back={{ to: '/admin/privacy', label: t('privacy.title') }} />
      <Panel className={styles.panel}>
        <EmptyState icon={<PersonInfo24Regular />} title={t('privacy.new.pickSubjectTitle')} message={t('privacy.new.pickSubject')}
          action={<span className={styles.startLinks}>
            <AppLink to="/organizations">{t('privacy.new.startFromContact')}</AppLink>
            <AppLink to="/sales/leads">{t('privacy.new.startFromLead')}</AppLink>
          </span>} />
      </Panel>
    </>
  );

  const today = todayIso();
  const back = state?.back ?? (subjectKind === 'Contact' ? `/contacts/${subjectId}` : '/sales/leads');
  return (
    <>
      <PageHeader title={t('privacy.new.title')} back={{ to: back, label: t('common.back') }} />
      <Panel title={t(`privacy.subjects.${subjectKind}`)} icon={<PersonInfo16Regular />} className={styles.panel}>
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
          <div className={styles.subject}>
            <PersonCell name={subjectName ?? t('privacy.new.subjectUnnamed')} />
          </div>
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
            <Button onClick={() => navigate(back)}>{t('common.cancel')}</Button>
            <Button appearance="primary" type="submit" disabled={open.isPending}>
              {t('privacy.new.submit')}
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
}
