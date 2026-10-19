import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
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
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import {
  type LegalHoldReason,
  type Plan,
  type PlannedErasure,
  type PrivacyCase,
  type VerificationMethod,
  useCaseActions,
  useHoldActions,
  usePrivacyCase,
  usePrivacyPlan,
} from './api';
import { ReasonDialog } from './ReasonDialog';
import { recordLabel } from './recordLabel';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  layout: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  details: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalL}`, margin: 0 },
  term: { color: tokens.colorNeutralForeground3 },
  definition: { margin: 0 },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  tableWrap: { overflowX: 'auto' },
  muted: { color: tokens.colorNeutralForeground3 },
  warning: { color: tokens.colorPaletteDarkOrangeForeground1 },
  mono: { fontFamily: tokens.fontFamilyMonospace, wordBreak: 'break-all' },
});

const methods: VerificationMethod[] = ['KnownEmail', 'InPerson', 'SignedLetter', 'Other'];
const holdReasons: LegalHoldReason[] = ['LegalClaim', 'AuthorityRequest', 'Bookkeeping', 'Other'];

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

  if (!allowed) return <NotFoundPage />;
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
          <Text>
            {t(`privacy.statuses.${c.status}`)}
            {c.overdue && <span className={styles.warning}> · {t('privacy.cases.overdue')}</span>}
          </Text>
        }
        actions={
          !closed && c.status !== 'Executing' ? (
            <Button onClick={() => setRejecting(true)}>{t('privacy.case.reject.button')}</Button>
          ) : undefined
        }
      />
      <div className={styles.layout}>
        <Panel title={t('privacy.case.details')}>
          <dl className={styles.details}>
            <dt className={styles.term}>{t('privacy.case.subject')}</dt>
            <dd className={styles.definition}>
              {t(`privacy.subjects.${c.subjectKind}`)}
              {c.subjectKind === 'Contact' && c.status !== 'Completed' && (
                <>
                  {' · '}
                  <AppLink to={`/contacts/${c.subjectId}`}>{t('privacy.case.openSubject')}</AppLink>
                </>
              )}
            </dd>
            <dt className={styles.term}>{t('privacy.case.channel')}</dt>
            <dd className={styles.definition}>{t(`privacy.channels.${c.channel}`)}</dd>
            <dt className={styles.term}>{t('privacy.case.received')}</dt>
            <dd className={styles.definition}>{formatDate(c.receivedAt)}</dd>
            <dt className={styles.term}>{t('privacy.case.due')}</dt>
            <dd className={styles.definition}>{formatDate(c.dueOn)}</dd>
            {c.note && (
              <>
                <dt className={styles.term}>{t('privacy.case.note')}</dt>
                <dd className={styles.definition}>{c.note}</dd>
              </>
            )}
            {c.verifiedAt && (
              <>
                <dt className={styles.term}>{t('privacy.case.verify.label')}</dt>
                <dd className={styles.definition}>
                  {t('privacy.case.verify.done', { method: t(`privacy.methods.${c.verificationMethod}`), date: formatDate(c.verifiedAt) })}
                </dd>
              </>
            )}
            {c.rejectionReason && (
              <>
                <dt className={styles.term}>{t('privacy.case.reject.label')}</dt>
                <dd className={styles.definition}>{c.rejectionReason}</dd>
              </>
            )}
          </dl>
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
    <Panel title={t('privacy.case.verify.title')}>
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
  const actions = useCaseActions(privacyCase.id);
  return (
    <Panel title={t('privacy.case.export.title')}>
      <div className={styles.stack}>
        <Text>{t('privacy.case.export.hint')}</Text>
        <div className={styles.actions}>
          <Button
            appearance="primary"
            disabled={actions.export.isPending}
            onClick={() => actions.export.mutate(undefined, { onError: (e) => notify(t('errors.generic'), 'error', errorMessage(e, t)) })}
          >
            {t('privacy.case.export.download')}
          </Button>
        </div>
        {privacyCase.exportSha256 && (
          <Text className={styles.muted}>
            {t('privacy.case.export.delivered', { date: formatDateTime(privacyCase.completedAt) })} <span className={styles.mono}>{privacyCase.exportSha256}</span>
          </Text>
        )}
      </div>
    </Panel>
  );
}

function ErasureStep({ privacyCase }: { privacyCase: PrivacyCase }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const styles = useStyles();
  const actions = useCaseActions(privacyCase.id);
  const plan = usePrivacyPlan(privacyCase.id, privacyCase.planDigest !== null);
  const [executing, setExecuting] = useState(false);
  const [holding, setHolding] = useState<PlannedErasure | null>(null);
  const [stalePlan, setStalePlan] = useState(false);
  const current = plan.data?.digest === privacyCase.planDigest ? plan.data : undefined;
  return (
    <Panel title={t('privacy.case.plan.title')}>
      <div className={styles.stack}>
        <Text>{t('privacy.case.plan.hint')}</Text>
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
        <div className={styles.actions}>
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
        </div>
        {current && <PlanView plan={current} onHold={privacyCase.status === 'Executing' ? undefined : setHolding} />}
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
  return (
    <>
      <ScrollTable className={styles.tableWrap}>
        <Table size="small" aria-label={t('privacy.case.plan.counts')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('privacy.case.plan.module')}</TableHeaderCell>
              <TableHeaderCell>{t('privacy.case.plan.action')}</TableHeaderCell>
              <TableHeaderCell>{t('privacy.case.plan.records')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {plan.counts.map((c) => (
              <TableRow key={`${c.module}-${c.action}`}>
                <TableCell>{t(`privacy.modules.${c.module}`, { defaultValue: c.module })}</TableCell>
                <TableCell>{t(`privacy.case.actions.${c.action}`)}</TableCell>
                <TableCell className="tabular">{c.records}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollTable>
      <ScrollTable className={styles.tableWrap}>
        <Table size="small" aria-label={t('privacy.case.plan.recordsLabel')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('privacy.case.plan.record')}</TableHeaderCell>
              <TableHeaderCell>{t('privacy.case.plan.action')}</TableHeaderCell>
              <TableHeaderCell>{t('privacy.case.plan.basis')}</TableHeaderCell>
              {onHold && <TableHeaderCell />}
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

function ExecuteDialog({ privacyCase, plan, open, onClose }: { privacyCase: PrivacyCase; plan: Plan | undefined; open: boolean; onClose: () => void }) {
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
            <DialogContent>
              <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
                <MessageBarBody>{t('privacy.case.execute.warning')}</MessageBarBody>
              </MessageBar>
              <Field label={t('privacy.case.execute.confirmation')} required>
                <Input value={confirmation} onChange={(_, d) => setConfirmation(d.value)} autoComplete="off" />
              </Field>
              {failure && (
                <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
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

function HoldDialog({ record, onClose, onPlaced }: { record: PlannedErasure | null; onClose: () => void; onPlaced: () => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useHoldActions();
  const [reason, setReason] = useState<LegalHoldReason>('LegalClaim');
  const [explanation, setExplanation] = useState('');
  const [until, setUntil] = useState('');
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
            <DialogContent>
              {record && <Text block style={{ marginBottom: tokens.spacingVerticalM }}>{recordLabel(t, record.record.module, record.record.entityType, record.record.entityId)}</Text>}
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

function ReceiptPanel({ privacyCase }: { privacyCase: PrivacyCase }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const navigate = useNavigate();
  const receipt = privacyCase.receipt!;
  const suppressions = receipt.suppressions.reduce((sum, s) => sum + s.count, 0);
  return (
    <Panel title={t('privacy.case.receipt.title')}>
      <div className={styles.stack}>
        <Text className={styles.muted}>{t('privacy.case.receipt.completed', { date: formatDateTime(privacyCase.completedAt) })}</Text>
        <ScrollTable className={styles.tableWrap}>
          <Table size="small" aria-label={t('privacy.case.receipt.modules')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('privacy.case.plan.module')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.case.receipt.done')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipt.modules.map((m) => (
                <TableRow key={m.module}>
                  <TableCell>{t(`privacy.modules.${m.module}`, { defaultValue: m.module })}</TableCell>
                  <TableCell>{m.actions.map((a) => `${t(`privacy.case.actions.${a.action}`)}: ${a.records}`).join(' · ')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTable>
        {receipt.retained.length > 0 && (
          <ScrollTable className={styles.tableWrap}>
            <Table size="small" aria-label={t('privacy.case.receipt.retained')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('privacy.case.receipt.retained')}</TableHeaderCell>
                  <TableHeaderCell>{t('privacy.case.plan.basis')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipt.retained.map((r) => (
                  <TableRow key={`${r.module}-${r.entityType}-${r.entityId}`}>
                    <TableCell>{recordLabel(t, r.module, r.entityType, r.entityId)}</TableCell>
                    <TableCell>
                      {r.basis && t(`privacy.case.bases.${r.basis}`)}
                      {r.until && <span className="tabular"> · {t('privacy.case.plan.until', { date: formatDate(r.until) })}</span>}
                      {r.note && <div className={styles.muted}>{r.note}</div>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        )}
        {receipt.retained.some((r) => r.basis === 'LegalHold') && (
          // A hold keeps its record only until it ends; then a new request for the same person erases what it kept.
          <MessageBar intent="info">
            <MessageBarBody>{t('privacy.case.receipt.held')}</MessageBarBody>
            <MessageBarActions>
              <Button
                onClick={() =>
                  navigate(`/admin/privacy/new?subjectKind=${privacyCase.subjectKind}&subjectId=${privacyCase.subjectId}&kind=Erasure`, {
                    state: { subjectName: t('privacy.new.samePerson', { number: privacyCase.number }), back: `/admin/privacy/cases/${privacyCase.id}` },
                  })
                }
              >
                {t('privacy.case.receipt.eraseAgain')}
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}
        {suppressions > 0 && <Text>{t('privacy.case.receipt.suppressions', { count: suppressions })}</Text>}
        {receipt.operatorErasure.length > 0 && (
          <MessageBar intent="info">
            <MessageBarBody>{t('privacy.case.receipt.operator')}</MessageBarBody>
          </MessageBar>
        )}
        {receipt.externalSystems.length > 0 && (
          <MessageBar intent="warning">
            <MessageBarBody>{t('privacy.case.receipt.external', { systems: receipt.externalSystems.map((s) => t(`systems.${s}`, { defaultValue: s })).join(', ') })}</MessageBarBody>
          </MessageBar>
        )}
      </div>
    </Panel>
  );
}
