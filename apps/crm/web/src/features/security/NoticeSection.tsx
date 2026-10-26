import { useRef, useState } from 'react';
import { Badge, Button, Field, Radio, RadioGroup, Spinner, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { formatDateTime, formatRelative } from '../../shared/utils/format';
import { ActionDialog } from '../actions/ActionDialog';
import { useActionAvailable } from '../actions/api';
import type { ActionRequest, VendorAction } from '../actions/types';
import type { Alert } from '../service/types';
import { securityRecord, useNotice } from './api';
import { alertActionRequest, isAccessEscalation, noticeStatus } from './securityText';
import type { Notice } from './types';

const useStyles = makeStyles({
  // One column that may shrink: a long option of a select or a long word never widens the panel past a phone's screen.
  section: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '12px', minWidth: 0 },
  heading: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 700 },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  status: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' },
  entities: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '2px', overflowWrap: 'anywhere' },
  form: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '10px', padding: '12px', borderRadius: '12px', backgroundColor: h.surface2 },
  send: { justifySelf: 'start' },
});

type Answer = 'close' | 'expected' | 'unauthorized';

/**
 * An escalation or a platform action of Huntress behind an alert (M41): what it is about, as the CRM last read it, and for an
 * escalation the way to close it with an answer. A platform action closes in Huntress once what it reports is put right: there is
 * nothing to send from here, and the panel says so.
 */
export function NoticeSection({ alert }: { alert: Alert }) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient();
  const record = securityRecord(alert);
  const read = useNotice(alert.system, record);
  const heading = useRef<HTMLHeadingElement>(null);
  const [ask, setAsk] = useState<{ request: ActionRequest; title: string; confirm: string } | null>(null);
  const finished = (action: VendorAction) => {
    if (action.status === 'Succeeded' || action.status === 'Skipped') {
      void read.refetch();
      void client.invalidateQueries({ queryKey: ['service', 'alerts'] });
    }
  };
  if (!record || record.kind === 'incident') return null;
  return <section className={styles.section} aria-labelledby={`notice-${alert.id}`}>
    <h3 id={`notice-${alert.id}`} ref={heading} tabIndex={-1} className={styles.heading}>
      {t(record.kind === 'escalation' ? 'security.notice.escalation' : 'security.notice.platformAction')}</h3>
    {read.isPending && <Spinner size="small" label={t('security.notice.loading')} />}
    {read.isError && <ErrorState error={read.error} onRetry={() => void read.refetch()} />}
    {read.data && <NoticeBody alert={alert} notice={read.data} onAsk={setAsk} />}
    <ActionDialog request={ask?.request ?? null} title={ask?.title ?? ''} confirm={ask?.confirm ?? ''} onFinished={finished}
      onClose={() => { setAsk(null); window.setTimeout(() => heading.current?.focus(), 0); }} />
  </section>;
}

function NoticeBody({ alert, notice, onAsk }: { alert: Alert; notice: Notice; onAsk: (ask: { request: ActionRequest; title: string; confirm: string }) => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const restore = useRestoreFocusTarget();
  const canWrite = useCan(Permissions.serviceWrite);
  const escalation = notice.kind === 'Escalation';
  const resolve = useActionAvailable(alert.system, 'escalation.resolve', canWrite && escalation && notice.isOpen);
  const access = isAccessEscalation(notice.typeCode);
  // An access escalation's answer stays with Huntress for good (allowed, or unauthorised from now on): none is chosen for the person.
  const [answer, setAnswer] = useState<Answer | null>(access ? null : 'close');
  const [touched, setTouched] = useState(false);
  const close = () => {
    setTouched(true);
    if (!answer) return;
    onAsk({
      request: alertActionRequest(alert, 'escalation.resolve', { answer }),
      title: t('security.notice.resolveTitle'), confirm: t(`security.notice.answers.${answer}.confirm`),
    });
  };
  return <>
    <span className={styles.status}>
      <Badge appearance="tint" color={notice.status === 'overdue' ? 'danger' : notice.isOpen ? 'warning' : 'subtle'}>{noticeStatus(t, notice.status)}</Badge>
      {notice.type && <Text className={styles.muted}>{notice.type}</Text>}
      <Text className={styles.muted}>{t('security.notice.readAt')} <time dateTime={notice.readAt} title={formatDateTime(notice.readAt)}>{formatRelative(notice.readAt)}</time></Text>
    </span>
    {notice.entities.length > 0 && <>
      <Text weight="semibold">{t('security.notice.about')}</Text>
      <ul className={styles.entities}>{notice.entities.map((entity, index) =>
        <li key={`${entity.type}-${entity.id ?? index}`}>{entity.name ?? entity.id ?? '—'} <Text className={styles.muted}>({t(`security.notice.entityTypes.${entity.type}`, { defaultValue: entity.type })})</Text></li>)}</ul>
      {!notice.allEntities && <Text block className={styles.muted}>{t('security.notice.moreEntities')}</Text>}
    </>}
    {!escalation && notice.isOpen && <Text block className={styles.muted}>{t('security.notice.platformActionNote')}</Text>}
    {escalation && resolve && <div className={styles.form}>
      {access && <Field label={t('security.notice.answer')} validationMessage={touched && !answer ? t('security.notice.answerMissing') : undefined}>
        <RadioGroup value={answer ?? ''} onChange={(_, data) => setAnswer(data.value as Answer)}>
          <Radio value="expected" label={t('security.notice.answers.expected.label')} />
          <Radio value="unauthorized" label={t('security.notice.answers.unauthorized.label')} />
          <Radio value="close" label={t('security.notice.answers.close.label')} />
        </RadioGroup>
      </Field>}
      {/* Only an access escalation comes back when it is closed without an answer; any other one is simply closed. */}
      {answer && <Text block className={styles.muted}>{t(access ? `security.notice.answers.${answer}.hint` : 'security.notice.answers.close.hintPlain')}</Text>}
      <Button {...restore} className={styles.send} size="small" onClick={close}>{t(`security.notice.answers.${answer ?? 'close'}.confirm`)}</Button>
    </div>}
  </>;
}
