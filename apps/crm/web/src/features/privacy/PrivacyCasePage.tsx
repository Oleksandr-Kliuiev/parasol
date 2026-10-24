import { useState } from 'react';
import { useParams } from 'react-router';
import {
  Button,
  Field,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowDownload16Regular, DocumentBulletList16Regular, Info16Regular, PersonAvailable16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime } from '../../shared/utils/format';
import { useSettingsStyles } from '../admin/settingsUi';
import { useTableCardStyles } from '../admin/tableCard';
import { NotFoundPage } from '../errors/NotFoundPage';
import { ForbiddenPage } from '../errors/ForbiddenPage';
import {
  type Plan,
  type PlannedErasure,
  type PrivacyCase,
  type VerificationMethod,
  useCaseActions,
  usePrivacyCase,
  usePrivacyPlan,
} from './api';
import { ExecuteDialog, HoldDialog } from './PrivacyCaseDialogs';
import { ReceiptPanel } from './PrivacyReceiptPanel';
import { CaseStatusBadge, OverdueBadge } from './privacyUi';
import { ReasonDialog } from './ReasonDialog';
import { recordLabel } from './recordLabel';

const useStyles = makeStyles({
  // The facts of the request on the left, the step that is due on the right; under each other on a narrow screen.
  layout: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))', gap: '16px', alignItems: 'start' },
  stack: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 },
  inner: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
  meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  // The buttons of a step at its foot, on the right, in the order of the work.
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '10px', paddingTop: '14px', borderTop: `1px solid ${h.line}` },
  muted: { color: h.muted, fontSize: '13px' },
  mono: { fontFamily: tokens.fontFamilyMonospace, fontSize: '12px' },
  number: { textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  numberHead: { textAlign: 'end', '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  table: { minWidth: '420px' },
  // The tables share their width equally between columns by default: the row button keeps to its size.
  holdCol: { width: '128px' },
});

const methods: VerificationMethod[] = ['KnownEmail', 'InPerson', 'SignedLetter', 'Other'];

/** One data subject request (DEV-11): verify the requester, then answer with the export or carry out the previewed erasure. */
export function PrivacyCasePage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const { id = '' } = useParams();
  const allowed = useCan(Permissions.privacyManage);
  const { data, error, isPending, refetch } = usePrivacyCase(id);
  const actions = useCaseActions(id);
  const [rejecting, setRejecting] = useState(false);

  if (!allowed) return <ForbiddenPage />;
  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const c = data;
  const closed = c.status === 'Completed' || c.status === 'Rejected';
  return (
    <>
      <PageHeader
        title={`${c.number} · ${t(`privacy.kinds.${c.kind}`)}`}
        back={{ to: '/admin/privacy', label: t('privacy.title') }}
        meta={
          <span className={styles.meta}>
            <CaseStatusBadge status={c.status} />
            {c.overdue && <OverdueBadge />}
          </span>
        }
        actions={
          !closed && c.status !== 'Executing' ? (
            <Button onClick={() => setRejecting(true)}>{t('privacy.case.reject.button')}</Button>
          ) : undefined
        }
      />
      <div className={styles.layout}>
        <Panel title={t('privacy.case.details')} icon={<Info16Regular />}>
          <DetailList
            items={[
              {
                label: t('privacy.case.subject'),
                value: (
                  <>
                    {t(`privacy.subjects.${c.subjectKind}`)}
                    {c.subjectKind === 'Contact' && c.status !== 'Completed' && (
                      <>
                        {' · '}
                        <AppLink to={`/contacts/${c.subjectId}`}>{t('privacy.case.openSubject')}</AppLink>
                      </>
                    )}
                  </>
                ),
              },
              { label: t('privacy.case.channel'), value: t(`privacy.channels.${c.channel}`) },
              { label: t('privacy.case.received'), value: formatDate(c.receivedAt) },
              { label: t('privacy.case.due'), value: formatDate(c.dueOn) },
              ...(c.note ? [{ label: t('privacy.case.note'), value: c.note }] : []),
              ...(c.verifiedAt
                ? [{ label: t('privacy.case.verify.label'), value: t('privacy.case.verify.done', { method: t(`privacy.methods.${c.verificationMethod}`), date: formatDate(c.verifiedAt) }) }]
                : []),
              ...(c.rejectionReason ? [{ label: t('privacy.case.reject.label'), value: c.rejectionReason }] : []),
            ]}
          />
        </Panel>

        <div className={styles.stack}>
          {!c.verifiedAt && !closed && <VerifyStep privacyCase={c} />}
          {c.verifiedAt && c.kind === 'Access' && c.status !== 'Rejected' && <ExportStep privacyCase={c} />}
          {c.verifiedAt && c.kind === 'Erasure' && !closed && <ErasureStep privacyCase={c} />}
          {c.kind === 'Erasure' && c.receipt && <ReceiptPanel privacyCase={c} />}
        </div>
      </div>
      <ReasonDialog
        open={rejecting}
        title={t('privacy.case.reject.title')}
        submit={t('privacy.case.reject.submit')}
        pending={actions.reject.isPending}
        onClose={() => setRejecting(false)}
        onSubmit={(reason) =>
          actions.reject.mutate(
            { etag: c.etag, reason },
            { onSuccess: () => setRejecting(false), onError: (e) => notify(t('errors.generic'), 'error', errorMessage(e, t)) },
          )
        }
      />
    </>
  );
}

function VerifyStep({ privacyCase }: { privacyCase: PrivacyCase }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const styles = useStyles();
  const actions = useCaseActions(privacyCase.id);
  const [method, setMethod] = useState<VerificationMethod>('KnownEmail');
  const [note, setNote] = useState('');
  return (
    <Panel title={t('privacy.case.verify.title')} icon={<PersonAvailable16Regular />}>
      <form
        className={styles.stack}
        onSubmit={(e) => {
          e.preventDefault();
          actions.verify.mutate(
            { etag: privacyCase.etag, method, note: note.trim() || null },
            { onError: (error) => notify(t('errors.generic'), 'error', errorMessage(error, t)) },
          );
        }}
      >
        <Field label={t('privacy.case.verify.method')}>
          <Select value={method} onChange={(_, d) => setMethod(d.value as VerificationMethod)}>
            {methods.map((m) => (
              <option key={m} value={m}>
                {t(`privacy.methods.${m}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('privacy.case.verify.note')} hint={t('privacy.case.verify.hint')}>
          <Textarea value={note} onChange={(_, d) => setNote(d.value)} maxLength={500} />
        </Field>
        <div className={styles.actions}>
          <Button appearance="primary" type="submit" disabled={actions.verify.isPending}>
            {t('privacy.case.verify.submit')}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function ExportStep({ privacyCase }: { privacyCase: PrivacyCase }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const styles = useStyles();
  const settings = useSettingsStyles();
  const actions = useCaseActions(privacyCase.id);
  return (
    <Panel title={t('privacy.case.export.title')} icon={<ArrowDownload16Regular />}>
      <div className={styles.inner}>
        <p className={settings.note}>{t('privacy.case.export.hint')}</p>
        {privacyCase.exportSha256 && (
          <Text className={styles.muted}>
            {/* The fingerprint by its start; the whole value stays in the tooltip for the operator who checks it. */}
            {t('privacy.case.export.delivered', { date: formatDateTime(privacyCase.completedAt) })}{' '}
            <span className={styles.mono} title={privacyCase.exportSha256}>{`${privacyCase.exportSha256.slice(0, 12)}…`}</span>
          </Text>
        )}
        <div className={styles.actions}>
          <Button
            appearance="primary"
            disabled={actions.export.isPending}
            onClick={() => actions.export.mutate(undefined, { onError: (e) => notify(t('errors.generic'), 'error', errorMessage(e, t)) })}
          >
            {t('privacy.case.export.download')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function ErasureStep({ privacyCase }: { privacyCase: PrivacyCase }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const styles = useStyles();
  const settings = useSettingsStyles();
  const actions = useCaseActions(privacyCase.id);
  const plan = usePrivacyPlan(privacyCase.id, privacyCase.planDigest !== null);
  const [executing, setExecuting] = useState(false);
  const [holding, setHolding] = useState<PlannedErasure | null>(null);
  const [stalePlan, setStalePlan] = useState(false);
  const current = plan.data?.digest === privacyCase.planDigest ? plan.data : undefined;
  return (
    <Panel title={t('privacy.case.plan.title')} icon={<DocumentBulletList16Regular />}>
      <div className={styles.inner}>
        <p className={settings.note}>{t('privacy.case.plan.hint')}</p>
        {privacyCase.status === 'Executing' && (
          <MessageBar intent="warning">
            <MessageBarBody>{t('privacy.case.plan.unfinished')}</MessageBarBody>
          </MessageBar>
        )}
        {stalePlan && (
          <MessageBar intent="info">
            <MessageBarBody>{t('privacy.case.plan.stale')}</MessageBarBody>
          </MessageBar>
        )}
        {current && <PlanView plan={current} onHold={privacyCase.status === 'Executing' ? undefined : setHolding} />}
        {(privacyCase.status !== 'Executing' || (current && !stalePlan)) && <div className={styles.actions}>
          {privacyCase.status !== 'Executing' && (
            <Button
              appearance={current ? 'secondary' : 'primary'}
              disabled={actions.preview.isPending}
              onClick={() =>
                actions.preview.mutate(
                  { etag: privacyCase.etag },
                  { onSuccess: () => setStalePlan(false), onError: (e) => notify(t('errors.generic'), 'error', errorMessage(e, t)) },
                )
              }
            >
              {current ? t('privacy.case.plan.previewAgain') : t('privacy.case.plan.preview')}
            </Button>
          )}
          {current && !stalePlan && (
            <Button appearance="primary" onClick={() => setExecuting(true)}>
              {t('privacy.case.execute.button')}
            </Button>
          )}
        </div>}
      </div>
      <ExecuteDialog privacyCase={privacyCase} plan={current} open={executing} onClose={() => setExecuting(false)} />
      <HoldDialog
        record={holding}
        onClose={() => setHolding(null)}
        onPlaced={() => {
          setHolding(null);
          setStalePlan(true);
        }}
      />
    </Panel>
  );
}

function PlanView({ plan, onHold }: { plan: Plan; onHold?: (record: PlannedErasure) => void }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const table = useTableCardStyles();
  return (
    <>
      <ScrollTable className={table.inset}>
        <Table size="small" className={styles.table} aria-label={t('privacy.case.plan.counts')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('privacy.case.plan.module')}</TableHeaderCell>
              <TableHeaderCell>{t('privacy.case.plan.action')}</TableHeaderCell>
              <TableHeaderCell className={styles.numberHead}>{t('privacy.case.plan.records')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.counts.map((c) => (
              <TableRow key={`${c.module}-${c.action}`}>
                <TableCell>{t(`privacy.modules.${c.module}`, { defaultValue: c.module })}</TableCell>
                <TableCell>{t(`privacy.case.actions.${c.action}`)}</TableCell>
                <TableCell className={styles.number}>{c.records}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollTable>
      <ScrollTable className={table.inset}>
        <Table size="small" className={styles.table} aria-label={t('privacy.case.plan.recordsLabel')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('privacy.case.plan.record')}</TableHeaderCell>
              <TableHeaderCell>{t('privacy.case.plan.action')}</TableHeaderCell>
              <TableHeaderCell>{t('privacy.case.plan.basis')}</TableHeaderCell>
              {onHold && <TableHeaderCell className={styles.holdCol} />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.records.map((p) => {
              const label = recordLabel(t, p.record.module, p.record.entityType, p.record.entityId);
              return (
                <TableRow key={`${p.record.module}-${p.record.entityType}-${p.record.entityId}`}>
                  <TableCell>{label}</TableCell>
                  <TableCell>{t(`privacy.case.actions.${p.action}`)}</TableCell>
                  <TableCell>
                    {p.basis && (
                      <>
                        {t(`privacy.case.bases.${p.basis}`)}
                        {p.retainUntil && <span className="tabular"> · {t('privacy.case.plan.until', { date: formatDate(p.retainUntil) })}</span>}
                        {p.note && <div className={styles.muted}>{p.note}</div>}
                      </>
                    )}
                  </TableCell>
                  {onHold && (
                    <TableCell>
                      {p.action !== 'Retain' && (
                        <Button size="small" appearance="subtle" onClick={() => onHold(p)} aria-label={t('privacy.case.plan.holdNamed', { record: label })}>
                          {t('privacy.case.plan.hold')}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ScrollTable>
    </>
  );
}
