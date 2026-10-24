import { useEffect, useId, useRef, useState } from 'react';
import { Button, Checkbox, Field, MessageBar, MessageBarBody, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { BuildingMultiple24Regular, CloudArrowDown20Regular, Database16Regular, DocumentArrowUp20Regular, LinkMultiple16Regular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError, query } from '../../api/client';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { h } from '../../app/hearth';
import { EmptyState } from '../../shared/components/EmptyState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { formatDateTime } from '../../shared/utils/format';
import { IconChip } from '../admin/IconChip';
import { NotFoundPage } from '../errors/NotFoundPage';
import { IdentityMappingRows } from './IdentityMappingRows';
import { loadAtlasIdentity } from './atlasIdentitySource';
import { buildIdentityImport, canConfirmIdentityPlan, IdentityInputError, readIdentityFile,
  type AtlasIdentitySnapshot, type IdentityImport, type IdentityPlan, type SelectedCustomer } from './identityImport';

const useStyles = makeStyles({
  body: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px', minWidth: 0 },
  card: { display: 'grid', gap: '14px', minWidth: 0 },
  // The one explaining line under a card title.
  lead: { margin: '-6px 0 0', color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
  note: { color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
  // The two sources side by side: the Atlas directory (the usual way) and an export file.
  sources: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '12px', minWidth: 0 },
  source: {
    display: 'grid',
    gridTemplateColumns: '36px minmax(0, 1fr)',
    alignItems: 'start',
    columnGap: '12px',
    rowGap: '10px',
    paddingTop: '14px',
    paddingBottom: '16px',
    paddingLeft: '16px',
    paddingRight: '16px',
    borderRadius: '16px',
    backgroundColor: h.well,
    minWidth: 0,
  },
  sourceBody: { display: 'grid', gap: '10px', minWidth: 0, justifyItems: 'start' },
  // The title sits on the middle line of its 36 px chip.
  sourceTitle: { margin: '8px 0 0', fontSize: '14px', lineHeight: '20px', fontWeight: 700 },
  sourceText: { margin: '-6px 0 0', color: h.muted, fontSize: '13px', lineHeight: '19px' },
  sourceAction: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' },
  file: { maxWidth: '100%', minWidth: 0 },
  workspace: { overflowWrap: 'anywhere' },
  // The foot of the card: what is selected on the left, the buttons in the order of the work on the right.
  footer: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: '16px',
    rowGap: '12px',
    paddingTop: '14px',
    borderTop: `1px solid ${h.line}`,
  },
  count: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', color: h.muted, fontSize: '13px', lineHeight: '20px' },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: tokens.spacingHorizontalS, marginLeft: 'auto',
    '@media (max-width: 560px)': { width: '100%', '& > .fui-Button': { flex: '1 1 auto' } } },
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
      {errorKey && <MessageBar layout="multiline" intent="error"><MessageBarBody>{t(`parasolIdentity.errors.${errorKey}`)}</MessageBarBody></MessageBar>}
      {atlasStatus && <MessageBar layout="multiline" intent="warning"><MessageBarBody>{t(`parasolIdentity.atlasStatus.${atlasStatus}`)}</MessageBarBody></MessageBar>}
      {!snapshot && <Panel title={t('parasolIdentity.sourceTitle')} icon={<Database16Regular />}><div className={styles.card}>
        <p className={styles.lead}>{t('parasolIdentity.instructions')}</p>
        <div className={styles.sources}>
          <div className={styles.source}>
            <IconChip icon={<CloudArrowDown20Regular />} tone="iris" />
            <div className={styles.sourceBody}>
              <h3 className={styles.sourceTitle}>{t('parasolIdentity.fromAtlas')}</h3>
              <p className={styles.sourceText}>{t('parasolIdentity.sourceHint')}</p>
              <div className={styles.sourceAction}>
                <Button appearance="primary" disabled={busy} onClick={() => void readAtlas()}>{t('parasolIdentity.loadAtlas')}</Button>
                {busy && <Spinner size="tiny" label={t('common.loading')} />}
              </div>
            </div>
          </div>
          <div className={styles.source}>
            <IconChip icon={<DocumentArrowUp20Regular />} tone="saffron" />
            <div className={styles.sourceBody}>
              <h3 className={styles.sourceTitle}>{t('parasolIdentity.fromFile')}</h3>
              <Field label={{ children: t('parasolIdentity.file'), htmlFor: fileId }}
                hint={{ children: t('parasolIdentity.fileHint'), id: `${fileId}-hint` }}>
                <input key={fileVersion} id={fileId} aria-describedby={`${fileId}-hint`} className={styles.file} type="file" accept=".json,application/json" disabled={busy}
                  onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void readFile(file); }} />
              </Field>
            </div>
          </div>
        </div>
      </div></Panel>}
      {snapshot && <Panel title={t('parasolIdentity.rows')} icon={<LinkMultiple16Regular />}
        actions={<Button size="small" disabled={busy} onClick={reset}>{t('parasolIdentity.reset')}</Button>}><div className={styles.card}>
        <DetailList items={[
          { label: t('parasolIdentity.source'), value: retrievedAt ? t('parasolIdentity.loadedAtlas', { time: formatDateTime(retrievedAt) }) : t('parasolIdentity.loadedFile') },
          { label: t('parasolIdentity.workspace'), value: <span className={styles.workspace}>{snapshot.workspaceId}</span> },
        ]} />
        <Text className={styles.note}>{retrievedAt ? t('parasolIdentity.loadedAtlasNote') : t('parasolIdentity.loadedFileNote')}</Text>
        {review && <MessageBar layout="multiline" intent={canConfirmIdentityPlan(review.plan) ? 'info' : 'warning'}>
          <MessageBarBody>{t(canConfirmIdentityPlan(review.plan) ? 'parasolIdentity.reviewReady' : 'parasolIdentity.reviewBlocked')}</MessageBarBody>
        </MessageBar>}
        {applied && <MessageBar layout="multiline" intent="success"><MessageBarBody>{t('parasolIdentity.applied', {
          created: applied.rows.filter(r => r.outcome === 'APPLIED').length,
          existing: applied.rows.filter(r => r.outcome === 'ALREADY_LINKED').length,
        })}</MessageBarBody></MessageBar>}
        {snapshot.clients.length === 0 ? <EmptyState message={t('parasolIdentity.empty')} icon={<BuildingMultiple24Regular />} /> :
          <IdentityMappingRows key={fileVersion} snapshot={snapshot} selected={selected} plan={plan} locked={busy} onSelect={(id, customer) => {
            clearReview(); setSelected(previous => { const next = new Map(previous); if (customer) next.set(id, customer); else next.delete(id); return next; });
          }} />}
        {review && canConfirmIdentityPlan(review.plan) && <Checkbox checked={confirmed} disabled={busy}
          onChange={(_, data) => setConfirmed(data.checked === true)} label={t('parasolIdentity.confirmLabel')} />}
        <div className={styles.footer}>
          <span className={styles.count} aria-live="polite">
            {busy && <Spinner size="extra-tiny" aria-label={t('common.loading')} />}
            <span>{t('parasolIdentity.selectionCount', { selected: selected.size, total: snapshot.clients.length, omitted: snapshot.clients.length - selected.size })}</span>
            {/* Why "Preview mappings" cannot be used yet. */}
            {selected.size === 0 && snapshot.clients.length > 0 && <span>{t('parasolIdentity.errors.noSelection')}</span>}
          </span>
          <div className={styles.actions}>
            {!review && !applied && <Button appearance="primary" disabled={busy || selected.size === 0} onClick={() => void preview()}>{t('parasolIdentity.preview')}</Button>}
            {review && <>
              <Button disabled={busy} onClick={clearReview}>{t('parasolIdentity.edit')}</Button>
              <Button appearance="primary" disabled={busy || !confirmed || !canConfirmIdentityPlan(review.plan)} onClick={() => void apply()}>{t('parasolIdentity.apply')}</Button>
            </>}
            {applied && <Button disabled={busy} onClick={clearReview}>{t('parasolIdentity.continue')}</Button>}
          </div>
        </div>
      </div></Panel>}
    </div>
  </>;
}
