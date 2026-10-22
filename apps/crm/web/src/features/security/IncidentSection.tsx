import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Badge, Button, Checkbox, Field, Select, Spinner, Text, Textarea, makeStyles, useRestoreFocusTarget,
} from '@fluentui/react-components';
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
import { securityRecord, useIncident } from './api';
import { DeviceIsolation } from './DeviceIsolation';
import {
  alertActionRequest, incidentStatus, indicatorName, maxSecurityText, rejectionReasons, remediationStatus, remediationType,
} from './securityText';
import type { Incident, Remediation } from './types';

const useStyles = makeStyles({
  // One column that may shrink: a long option of a select or a long word never widens the panel past a phone's screen.
  section: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '12px', minWidth: 0 },
  heading: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 700 },
  subheading: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 700 },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  text: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '14px', lineHeight: '20px' },
  status: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' },
  chips: { listStyleType: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: '6px' },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: '6px', minHeight: '28px', paddingLeft: '10px', paddingRight: '10px', borderRadius: '999px',
    border: `1px solid ${h.line}`, color: h.muted, fontSize: '12.5px', fontWeight: 700, '& b': { color: h.text, fontVariantNumeric: 'tabular-nums' },
  },
  list: { listStyleType: 'none', margin: 0, padding: 0, display: 'grid', gap: '8px' },
  item: { display: 'grid', gap: '6px', padding: '10px 12px', borderRadius: '12px', border: `1px solid ${h.line}`, minWidth: 0 },
  itemHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', overflowWrap: 'anywhere' },
  details: { margin: 0, display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '2px 10px', fontSize: '12.5px', lineHeight: '18px' },
  pair: { display: 'contents' },
  detailName: { color: h.muted },
  detailValue: { margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflowWrap: 'anywhere' },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  form: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '10px', padding: '12px', borderRadius: '12px', backgroundColor: h.surface2 },
  quote: { margin: 0, paddingLeft: '12px', borderLeft: `3px solid ${h.line2}`, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '30vh', overflowY: 'auto' },
  comment: { display: 'grid', gap: '4px', padding: '10px 12px', borderRadius: '12px', border: `1px solid ${h.line}`, minWidth: 0 },
  commentHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', fontSize: '12.5px', lineHeight: '18px', color: h.muted },
  author: { fontWeight: 600, color: h.text },
  body: { maxHeight: '40vh', overflowY: 'auto', padding: '10px 12px', borderRadius: '12px', backgroundColor: h.surface2 },
  send: { justifySelf: 'start' },
  // A native select is as wide as its longest option unless it may shrink: the reasons list fits a 320 px screen this way.
  shrink: { minWidth: 0 },
});

type Ask = { request: ActionRequest; title: string; confirm: string; details?: ReactNode; onAccepted?: () => void };

/** A moment as a list says it: relative, with the exact time for a pointer and for assistive technology. */
function When({ at }: { at: string }) {
  return <time dateTime={at} title={formatDateTime(at)}>{formatRelative(at)}</time>;
}

/**
 * The Huntress incident behind an alert (M41): what Huntress's SOC found and wrote, the indicators, the plan of remediation steps
 * and the comments, as the CRM last read them, and what can be done about it from here — approve or send back the plan, mark the
 * manual steps, resolve it, comment, isolate the machine. Every change goes through the one action confirmation; the record is read
 * again once Huntress has it.
 */
export function IncidentSection({ alert }: { alert: Alert }) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient();
  const record = securityRecord(alert);
  const read = useIncident(alert.system, record);
  const incident = read.data;
  const [ask, setAsk] = useState<Ask | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const finished = (action: VendorAction) => {
    if (action.status === 'Succeeded' || action.status === 'Skipped') {
      void read.refetch();
      void client.invalidateQueries({ queryKey: ['service', 'alerts'] });
      void client.invalidateQueries({ queryKey: ['service', 'machine'] });
    }
  };
  if (!record || record.kind !== 'incident') return null;
  return <section className={styles.section} aria-labelledby={`incident-${alert.id}`}>
    <h3 id={`incident-${alert.id}`} ref={heading} tabIndex={-1} className={styles.heading}>{t('security.incident.heading')}</h3>
    {read.isPending && <Spinner size="small" label={t('security.incident.loading')} />}
    {read.isError && <ErrorState error={read.error} onRetry={() => void read.refetch()} />}
    {incident && <IncidentBody alert={alert} incident={incident} onAsk={setAsk} />}
    <ActionDialog request={ask?.request ?? null} title={ask?.title ?? ''} confirm={ask?.confirm ?? ''} details={ask?.details}
      onAccepted={() => ask?.onAccepted?.()} onFinished={finished}
      onClose={() => { setAsk(null); window.setTimeout(() => heading.current?.focus(), 0); }} />
  </section>;
}

function IncidentBody({ alert, incident, onAsk }: { alert: Alert; incident: Incident; onAsk: (ask: Ask) => void }) {
  const { t } = useTranslation(); const styles = useStyles();
  const canWrite = useCan(Permissions.serviceWrite);
  const open = canWrite && incident.isOpen;
  const approve = useActionAvailable(alert.system, 'incident.approve', open);
  const reject = useActionAvailable(alert.system, 'incident.reject', open);
  const resolve = useActionAvailable(alert.system, 'incident.resolve', open);
  const step = useActionAvailable(alert.system, 'incident.step', open);
  // Huntress takes no comment on a report it no longer knows.
  const comment = useActionAvailable(alert.system, 'incident.comment', canWrite && incident.status !== 'deleted');
  const [showBody, setShowBody] = useState(false); const [rejecting, setRejecting] = useState(false);
  const restore = useRestoreFocusTarget(); const rejectButton = useRef<HTMLButtonElement>(null);
  const closeReject = () => { setRejecting(false); window.setTimeout(() => rejectButton.current?.focus(), 0); };
  const waiting = incident.remediations.filter((r) => r.status === 'unapproved');
  // Huntress takes an answer to the plan only while the report waits for the partner (`sent`).
  const answerable = incident.status === 'sent' && waiting.length > 0;
  const resolvable = incident.status === 'sent' && waiting.length === 0;

  return <>
    <span className={styles.status}>
      <Badge appearance="tint" color={incident.isOpen ? (incident.status === 'sent' ? 'warning' : 'informative') : 'subtle'}>
        {incidentStatus(t, incident.status)}</Badge>
      <Text className={styles.muted}>{t('security.incident.readAt')} <When at={incident.readAt} /></Text>
    </span>
    {incident.summary && <p className={styles.text}>{incident.summary}</p>}
    {incident.indicators.length > 0 && <ul className={styles.chips} aria-label={t('security.incident.indicators')}>
      {incident.indicators.map((indicator) => <li key={indicator.type} className={styles.chip}>
        {indicatorName(t, indicator.type)} <b>{indicator.count}</b></li>)}
    </ul>}

    <h4 className={styles.subheading}>{t('security.remediation.heading')}</h4>
    {incident.remediations.length === 0
      ? <Text block className={styles.muted}>{t('security.remediation.none')}</Text>
      : <ul className={styles.list}>{incident.remediations.map((remediation) => <RemediationItem key={remediation.externalId} remediation={remediation}
        canMark={step && remediation.type === 'manual'} onMark={(completed) => onAsk({
          request: alertActionRequest(alert, 'incident.step', { remediation: remediation.externalId, completed }),
          title: t(completed ? 'security.remediation.markTitle' : 'security.remediation.unmarkTitle'),
          confirm: t(completed ? 'security.remediation.mark' : 'security.remediation.unmark'),
        })} />)}</ul>}
    {(answerable && (approve || reject)) || (resolvable && resolve) ? <span className={styles.buttons}>
      {/* The panel's one primary button is the task's; the plan's answer is a plain one (UX-2026). */}
      {answerable && approve && <Button {...restore} size="small" onClick={() => onAsk({
        request: alertActionRequest(alert, 'incident.approve'), title: t('security.remediation.approveTitle'), confirm: t('security.remediation.approve'),
      })}>{t('security.remediation.approve')}</Button>}
      {/* A disclosure: the form opens under it with focus in its first field, and closing it brings focus back here. */}
      {answerable && reject && <Button ref={rejectButton} size="small" aria-expanded={rejecting}
        onClick={() => (rejecting ? closeReject() : setRejecting(true))}>{t('security.remediation.reject')}</Button>}
      {resolvable && resolve && <Button {...restore} size="small" onClick={() => onAsk({
        request: alertActionRequest(alert, 'incident.resolve'), title: t('security.incident.resolveTitle'), confirm: t('security.incident.resolve'),
      })}>{t('security.incident.resolve')}</Button>}
    </span> : null}
    {answerable && reject && rejecting && <RejectForm alert={alert} incident={incident} onCancel={closeReject}
      onAsk={(next) => onAsk({ ...next, onAccepted: () => setRejecting(false) })} />}
    {incident.isOpen && incident.status === 'draft' && <Text block className={styles.muted}>{t('security.incident.draftNote')}</Text>}

    {alert.machineId && <DeviceIsolation machineId={alert.machineId} agentExternalId={incident.agentExternalId} deviceId={alert.deviceId} />}

    <Comments alert={alert} incident={incident} canComment={comment} onAsk={onAsk} />

    {incident.body && <div>
      <Button size="small" appearance="subtle" aria-expanded={showBody} onClick={() => setShowBody((value) => !value)}>
        {t(showBody ? 'security.incident.hideDetails' : 'security.incident.showDetails')}</Button>
      {showBody && <div className={styles.body} role="region" aria-label={t('security.incident.details')} tabIndex={0}>
        <p className={styles.text}>{incident.body}</p></div>}
    </div>}
  </>;
}

function RemediationItem({ remediation, canMark, onMark }: { remediation: Remediation; canMark: boolean; onMark: (completed: boolean) => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const restore = useRestoreFocusTarget();
  const done = remediation.status === 'completed';
  const color = done ? 'success' : remediation.status === 'failed' ? 'danger' : remediation.status === 'unapproved' ? 'warning' : 'informative';
  return <li className={styles.item}>
    <span className={styles.itemHead}>
      <Text weight="semibold">{remediation.action ?? t('security.remediation.unnamed')}</Text>
      <Badge appearance="outline" color="informative">{remediationType(t, remediation.type)}</Badge>
      <Badge appearance="tint" color={color}>{remediationStatus(t, remediation.status)}</Badge>
    </span>
    {remediation.details.length > 0 && <dl className={styles.details}>{remediation.details.map((detail, index) => <div key={index} className={styles.pair}>
      <dt className={styles.detailName}>{detail.name ?? '—'}</dt><dd className={styles.detailValue}>{detail.value}</dd></div>)}</dl>}
    {(remediation.approvedAt || remediation.completedAt) && <Text size={200} className={styles.muted}>
      {[remediation.approvedAt && t('security.remediation.approvedBy', { name: remediation.approvedBy ?? t('security.remediation.someone'), date: formatDateTime(remediation.approvedAt) }),
        remediation.completedAt && t('security.remediation.completedAt', { date: formatDateTime(remediation.completedAt) })].filter(Boolean).join(' · ')}</Text>}
    {canMark && <span className={styles.buttons}>
      <Button {...restore} size="small" appearance={done ? 'subtle' : 'secondary'} onClick={() => onMark(!done)}>
        {t(done ? 'security.remediation.unmark' : 'security.remediation.mark')}</Button>
    </span>}
  </li>;
}

/** Sending a plan back to Huntress's SOC: why (one of Huntress's reasons), what the SOC should know, and whether the plan helped. */
function RejectForm({ alert, incident, onCancel, onAsk }: { alert: Alert; incident: Incident; onCancel: () => void; onAsk: (ask: Ask) => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const restore = useRestoreFocusTarget();
  const reasons = incident.platform === 'microsoft_365' ? rejectionReasons.m365 : rejectionReasons.endpoint;
  // No reason is chosen for the person: a preselected one would go to Huntress's SOC unread.
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState(''); const [useful, setUseful] = useState(false); const [touched, setTouched] = useState(false);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const text = comment.trim();
  const go = () => {
    setTouched(true);
    if (!reason || !text) return;
    onAsk({
      request: alertActionRequest(alert, 'incident.reject', { reason, comment: text, useful }),
      title: t('security.remediation.rejectTitle'), confirm: t('security.remediation.rejectConfirm'),
      details: <blockquote className={styles.quote}>{t(`security.remediation.reasons.${reason}`)}{'\n\n'}{text}</blockquote>,
    });
  };
  return <div className={styles.form} role="group" aria-label={t('security.remediation.reject')}>
    <Field className={styles.shrink} label={t('security.remediation.reason')} required
      validationMessage={touched && !reason ? t('security.remediation.reasonMissing') : undefined}>
      <Select ref={first} className={styles.shrink} select={{ className: styles.shrink }} value={reason} onChange={(_, data) => setReason(data.value)}>
        <option value="" disabled>{t('security.remediation.reasonChoose')}</option>
        {reasons.map((code) => <option key={code} value={code}>{t(`security.remediation.reasons.${code}`)}</option>)}
      </Select>
    </Field>
    <Field label={t('security.remediation.rejectComment')} hint={t('security.remediation.rejectHint')} required
      validationMessage={touched && !text ? t('security.remediation.rejectCommentMissing') : undefined}>
      <Textarea value={comment} onChange={(_, data) => setComment(data.value)} maxLength={maxSecurityText} resize="vertical" rows={3} />
    </Field>
    <Checkbox checked={useful} onChange={(_, data) => setUseful(data.checked === true)} label={t('security.remediation.useful')} />
    <span className={styles.buttons}>
      <Button {...restore} size="small" onClick={go}>{t('security.remediation.rejectContinue')}</Button>
      <Button size="small" onClick={onCancel}>{t('common.cancel')}</Button>
    </span>
  </div>;
}

/** The incident's comments as the CRM last read them, oldest first, and a new one (everyone of the account who sees the report reads it). */
function Comments({ alert, incident, canComment, onAsk }: { alert: Alert; incident: Incident; canComment: boolean; onAsk: (ask: Ask) => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const restore = useRestoreFocusTarget();
  const [text, setText] = useState('');
  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onAsk({
      request: alertActionRequest(alert, 'incident.comment', { text: trimmed }),
      title: t('security.comments.addTitle'), confirm: t('security.comments.add'),
      details: <blockquote className={styles.quote}>{trimmed}</blockquote>,
      // Emptied once the command is saved, so a closed dialog never leaves a sent text to be sent again.
      onAccepted: () => setText(''),
    });
  };
  return <>
    <h4 className={styles.subheading}>{t('security.comments.heading')}</h4>
    <Text className={styles.muted}>{incident.commentsReadAt
      ? <>{t('security.comments.readAt')} <When at={incident.commentsReadAt} /></>
      : t('security.comments.notRead')}</Text>
    {incident.comments.length > 0 && <ol className={styles.list}>{incident.comments.map((comment) => <li key={comment.externalId} className={styles.comment}>
      <div className={styles.commentHead}>
        <span className={styles.author}>{comment.author ?? t('security.comments.unknownAuthor')}</span>
        <When at={comment.createdAt} />
      </div>
      <p className={styles.text}>{comment.body}</p>
    </li>)}</ol>}
    {incident.comments.length === 0 && incident.commentsReadAt && <Text block className={styles.muted}>{t('security.comments.none')}</Text>}
    {canComment && <div className={styles.form}>
      <Field label={t('security.comments.label')} hint={t('security.comments.hint')}>
        <Textarea value={text} onChange={(_, data) => setText(data.value)} maxLength={maxSecurityText} resize="vertical" rows={3} />
      </Field>
      <Button {...restore} className={styles.send} size="small" disabled={!text.trim()} disabledFocusable={!text.trim()} onClick={send}>
        {t('security.comments.add')}</Button>
    </div>}
  </>;
}
