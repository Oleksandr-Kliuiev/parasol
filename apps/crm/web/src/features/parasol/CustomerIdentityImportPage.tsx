import { useEffect, useId, useRef, useState } from 'react';
import { Button, Checkbox, Field, MessageBar, MessageBarBody, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError, query } from '../../api/client';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { PageHeader } from '../../shared/components/PageHeader';
import { formatDateTime } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { IdentityMappingRows } from './IdentityMappingRows';
import { loadAtlasIdentity } from './atlasIdentitySource';
import { buildIdentityImport, canConfirmIdentityPlan, IdentityInputError, readIdentityFile,
  type AtlasIdentitySnapshot, type IdentityImport, type IdentityPlan, type SelectedCustomer } from './identityImport';

const useStyles = makeStyles({
  body: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: tokens.spacingVerticalM, maxWidth: '960px', minWidth: 0 },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM },
  workspace: { overflowWrap: 'anywhere' },
  file: { width: '100%', minWidth: 0 },
});
const endpoint = '/api/v1/parasol/customer-identities/import';

export function CustomerIdentityImportPage() {
  const allowed = useCan(Permissions.integrationsManage);
  const user = useCurrentUser();
  return allowed ? <IdentityImportForm key={user.id} /> : <NotFoundPage />;
}

function IdentityImportForm() {
  const { t } = useTranslation();
  const styles = useStyles();
  const client = useQueryClient();
  const fileId = useId();
  const [snapshot, setSnapshot] = useState<AtlasIdentitySnapshot | null>(null);
  const [selected, setSelected] = useState(new Map<string, SelectedCustomer>());
  const [review, setReview] = useState<{ body: IdentityImport; plan: IdentityPlan } | null>(null);
  const [applied, setApplied] = useState<IdentityPlan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [fileVersion, setFileVersion] = useState(0);
  const [atlasStatus, setAtlasStatus] = useState<string | null>(null);
  const [retrievedAt, setRetrievedAt] = useState<string | null>(null);
  const sourceRequest = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sourceRequest.current?.abort(); }; }, []);

  const clearReview = () => { setReview(null); setApplied(null); setConfirmed(false); setErrorKey(null); };
  const reset = () => {
    clearReview(); setSnapshot(null); setSelected(new Map()); setFileVersion(n => n + 1);
    setAtlasStatus(null); setRetrievedAt(null);
  };
  const readFile = async (file: File) => {
    reset(); setBusy(true);
    try {
      const next = await readIdentityFile(file);
      if (alive.current) setSnapshot(next);
    } catch (error) {
      if (alive.current) setErrorKey(error instanceof IdentityInputError ? error.code : 'invalidFile');
    } finally { if (alive.current) setBusy(false); }
  };
  const readAtlas = async () => {
    if (busy) return;
    reset(); setBusy(true);
    const request = new AbortController(); sourceRequest.current = request;
    try {
      const result = await loadAtlasIdentity(request.signal);
      if (!alive.current) return;
      if (result.status === 'READY') { setSnapshot(result.snapshot); setRetrievedAt(result.retrievedAt); }
      else setAtlasStatus(result.status);
    } catch (error) {
      if (alive.current) setErrorKey(error instanceof ApiError && error.status === 403 ? 'forbidden'
        : error instanceof ApiError && error.status === 429 ? 'sourceRateLimited' : 'sourceFailed');
    } finally {
      if (sourceRequest.current === request) sourceRequest.current = null;
      if (alive.current) setBusy(false);
    }
  };
  const preview = async () => {
    if (!snapshot) return;
    clearReview(); setBusy(true);
    try {
      const body = buildIdentityImport(snapshot, selected);
      const { data } = await api.post<IdentityPlan>(`${endpoint}?dryRun=true`, body);
      if (alive.current) setReview({ body, plan: data });
    } catch (error) {
      if (alive.current) setErrorKey(error instanceof IdentityInputError ? error.code
        : error instanceof ApiError && error.status === 403 ? 'forbidden' : 'previewFailed');
    } finally { if (alive.current) setBusy(false); }
  };
  const apply = async () => {
    if (!review || !confirmed || busy || !canConfirmIdentityPlan(review.plan)) return;
    setBusy(true); setErrorKey(null);
    try {
      // Keep the exact reviewed body and server hash; never rebuild it from editable selections.
      const { data } = await api.post<IdentityPlan>(`${endpoint}${query({ dryRun: false, expectedSha256: review.plan.sha256 })}`, review.body);
      if (alive.current) { setApplied(data); setReview(null); }
    } catch (error) {
      if (alive.current) {
        setReview(null); setConfirmed(false);
        setErrorKey(error instanceof ApiError && error.code === 'PARASOL_IDENTITY_CONFLICT' ? 'conflict' : 'applyUncertain');
      }
    } finally {
      // Also refresh after a lost response: the atomic operation may already have committed.
      void client.invalidateQueries({ queryKey: ['parasol'] });
      void client.invalidateQueries({ queryKey: ['integrations'] });
      if (alive.current) setBusy(false);
    }
  };
  const plan = applied ?? review?.plan ?? null;
  return <>
    <PageHeader title={t('parasolIdentity.title')} subtitle={t('parasolIdentity.subtitle')}
      back={{ to: '/admin/mappings', label: t('mappings.title') }} />
    <div className={styles.body}>
      <Text>{t('parasolIdentity.instructions')}</Text>
      {errorKey && <MessageBar layout="multiline" intent="error"><MessageBarBody>{t(`parasolIdentity.errors.${errorKey}`)}</MessageBarBody></MessageBar>}
      {atlasStatus && <MessageBar layout="multiline" intent="warning"><MessageBarBody>{t(`parasolIdentity.atlasStatus.${atlasStatus}`)}</MessageBarBody></MessageBar>}
      {!snapshot && <>
        <div className={styles.actions}><Button appearance="primary" disabled={busy} onClick={() => void readAtlas()}>{t('parasolIdentity.loadAtlas')}</Button></div>
        <Text>{t('parasolIdentity.sourceHint')}</Text>
        <Field label={{ children: t('parasolIdentity.file'), htmlFor: fileId }}
        hint={{ children: t('parasolIdentity.fileHint'), id: `${fileId}-hint` }}>
        <input key={fileVersion} id={fileId} aria-describedby={`${fileId}-hint`} className={styles.file} type="file" accept=".json,application/json" disabled={busy}
          onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void readFile(file); }} />
        </Field>
      </>}
      {busy && <Spinner size="small" label={t('common.loading')} />}
      {snapshot && <>
        <Text>{retrievedAt ? t('parasolIdentity.loadedAtlas', { time: formatDateTime(retrievedAt) }) : t('parasolIdentity.loadedFile')}</Text>
        <Text className={styles.workspace} weight="semibold">{t('parasolIdentity.workspace')}: {snapshot.workspaceId}</Text>
        <Text>{t('parasolIdentity.selectionCount', { selected: selected.size, total: snapshot.clients.length, omitted: snapshot.clients.length - selected.size })}</Text>
        {snapshot.clients.length === 0 && <Text role="status">{t('parasolIdentity.empty')}</Text>}
        {review && <MessageBar layout="multiline" intent={canConfirmIdentityPlan(review.plan) ? 'info' : 'warning'}>
          <MessageBarBody>{t(canConfirmIdentityPlan(review.plan) ? 'parasolIdentity.reviewReady' : 'parasolIdentity.reviewBlocked')}</MessageBarBody>
        </MessageBar>}
        {applied && <MessageBar layout="multiline" intent="success"><MessageBarBody>{t('parasolIdentity.applied', {
          created: applied.rows.filter(r => r.outcome === 'APPLIED').length,
          existing: applied.rows.filter(r => r.outcome === 'ALREADY_LINKED').length,
        })}</MessageBarBody></MessageBar>}
        <IdentityMappingRows key={fileVersion} snapshot={snapshot} selected={selected} plan={plan} locked={busy} onSelect={(id, customer) => {
          clearReview(); setSelected(previous => { const next = new Map(previous); if (customer) next.set(id, customer); else next.delete(id); return next; });
        }} />
        {review && canConfirmIdentityPlan(review.plan) && <Checkbox checked={confirmed} disabled={busy}
          onChange={(_, data) => setConfirmed(data.checked === true)} label={t('parasolIdentity.confirmLabel')} />}
        <div className={styles.actions}>
          {!review && !applied && <Button appearance="primary" disabled={busy || selected.size === 0} onClick={() => void preview()}>{t('parasolIdentity.preview')}</Button>}
          {review && <>
            <Button disabled={busy} onClick={clearReview}>{t('parasolIdentity.edit')}</Button>
            <Button appearance="primary" disabled={busy || !confirmed || !canConfirmIdentityPlan(review.plan)} onClick={() => void apply()}>{t('parasolIdentity.apply')}</Button>
          </>}
          {applied && <Button disabled={busy} onClick={clearReview}>{t('parasolIdentity.continue')}</Button>}
          <Button disabled={busy} onClick={reset}>{t('parasolIdentity.reset')}</Button>
        </div>
      </>}
    </div>
  </>;
}
