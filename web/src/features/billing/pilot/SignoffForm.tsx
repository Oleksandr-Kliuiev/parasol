import { useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Field, MessageBar, MessageBarActions, MessageBarBody, Select, Textarea } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { useCurrentUser } from '../../../auth/CurrentUserContext';
import { Panel } from '../../../shared/components/Panel';
import { UnsavedChangesDialog } from '../../../shared/forms/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../shared/forms/useUnsavedChanges';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { useSignoff, type ComparisonResult, type PilotOverview, type SignoffResult } from './api';
import { EXPLANATION_MAX, EXPLANATION_MIN, FALLBACK_MAX, FALLBACK_MIN, ownerRoles } from './constants';
import { Verdict } from './parts';
import { money, usePilotStyles } from './styles';

interface Entry {
  text: string;
  role: string;
}

const lengthOk = (value: string, min: number, max: number) => value.trim().length >= min && value.trim().length <= max;

interface SignoffFormProps {
  result: ComparisonResult;
  overview: PilotOverview | undefined;
  /** The run as the page last read it; its ETag is the precondition of the signature. */
  run: { etag: string; contentRevision: number };
  onSigned: (result: SignoffResult) => void;
  /** Reloads the run and the overview after a 412 or a stale comparison; what was typed stays. */
  onReload: () => void;
}

/**
 * The Finance sign-off of one comparison. Every difference needs an explanation and an owner, the fallback process is written
 * out, and the signer confirms the sentence the server gave. The signer is the signed-in user: nothing is prefilled that would
 * look like a signature, and the form never names anybody else.
 */
export function SignoffForm({ result, overview, run, onSigned, onReload }: SignoffFormProps) {
  const styles = usePilotStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const me = useCurrentUser();
  const signoff = useSignoff(result.comparison.runId);
  const busy = useRef(false);
  // Once signed, this comparison is done: a late second click must not sign it again.
  const [done, setDone] = useState(false);
  const exceptions = useMemo(() => result.comparison.items.filter((i) => i.status !== 'Matched'), [result.comparison.items]);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [fallback, setFallback] = useState('');
  // The sentence the user ticked; if the server's sentence changes meanwhile the tick no longer counts.
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string; status?: number; keys: string[] } | null>(null);

  const dirty = fallback !== '' || confirmed !== null || Object.values(entries).some((e) => e.text !== '' || e.role !== '');
  const { blocker, markSaved } = useUnsavedChanges(dirty);

  const statement = overview?.statement ?? '';
  const comparisonInfo = overview?.comparisons.find((c) => c.id === result.comparison.comparisonId);
  const stale = run.contentRevision !== result.comparison.runContentRevision || comparisonInfo?.stale === true;
  const allExplained = exceptions.every((item) => {
    const entry = entries[item.key];
    return entry && lengthOk(entry.text, EXPLANATION_MIN, EXPLANATION_MAX) && (ownerRoles as readonly string[]).includes(entry.role);
  });
  const statementOk = statement !== '' && confirmed === statement;
  const canSubmit = allExplained && lengthOk(fallback, FALLBACK_MIN, FALLBACK_MAX) && statementOk && !stale && !signoff.isPending && !done;

  const setEntry = (key: string, patch: Partial<Entry>) =>
    setEntries((current) => ({ ...current, [key]: { text: '', role: '', ...current[key], ...patch } }));

  const submit = async () => {
    if (busy.current || done || !canSubmit) return;
    busy.current = true;
    setError(null);
    try {
      const response = await signoff.mutateAsync({
        etag: run.etag,
        request: {
          comparisonId: result.comparison.comparisonId,
          comparisonSha256: result.documentSha256,
          explanations: exceptions.map((item) => ({ key: item.key, text: entries[item.key]!.text.trim(), ownerRole: entries[item.key]!.role })),
          fallbackProcess: fallback.trim(),
          statement,
        },
      });
      markSaved();
      setDone(true);
      notify(t('pilot.signoff.signed'));
      onSigned(response.data);
    } catch (e) {
      const api = e instanceof ApiError ? e : null;
      const keys = api?.code === 'BIL_PILOT_UNEXPLAINED' && Array.isArray(api.problem.keys) ? (api.problem.keys as string[]) : [];
      setError({ message: errorMessage(e, t), code: api?.code, status: api?.status, keys });
    } finally {
      busy.current = false;
    }
  };

  return (
    <Panel title={t('pilot.signoff.title')}>
      <p style={{ marginTop: 0 }}>{t('pilot.signoff.intro', { number: exceptions.length })}</p>
      <p className={styles.muted}>{t('pilot.signoff.signer', { name: me.displayName })}</p>
      {stale && (
        <MessageBar intent="warning" layout="multiline" role="alert" style={{ marginBottom: 12 }}>
          <MessageBarBody>{t('pilot.signoff.stale')}</MessageBarBody>
        </MessageBar>
      )}

      {exceptions.length === 0 ? (
        <p>{t('pilot.signoff.nothingToExplain')}</p>
      ) : (
        <div className={styles.stack}>
          {exceptions.map((item) => {
            const entry = entries[item.key] ?? { text: '', role: '' };
            const short = entry.text !== '' && !lengthOk(entry.text, EXPLANATION_MIN, EXPLANATION_MAX);
            return (
              <fieldset key={item.key} className={styles.group}>
                <legend style={{ padding: '0 4px', maxWidth: '100%' }}>
                  <span className={styles.mono}>{item.key}</span> <Verdict status={item.status} />
                  {item.difference !== null && item.difference !== undefined && ` · ${money(item.difference, item.currency)}`}
                </legend>
                <div className={styles.stack} style={{ gap: 8 }}>
                  <Field
                    label={t('pilot.signoff.explanation')}
                    hint={t('pilot.signoff.counter', { length: entry.text.trim().length, min: EXPLANATION_MIN, max: EXPLANATION_MAX })}
                    validationState={short ? 'error' : 'none'}
                    validationMessage={short ? t('pilot.signoff.lengthRule', { min: EXPLANATION_MIN, max: EXPLANATION_MAX }) : undefined}
                    required
                  >
                    <Textarea
                      aria-label={`${t('pilot.signoff.explanation')} ${item.key}`}
                      value={entry.text}
                      maxLength={EXPLANATION_MAX}
                      resize="vertical"
                      rows={2}
                      onChange={(_, d) => setEntry(item.key, { text: d.value })}
                    />
                  </Field>
                  <Field label={t('pilot.signoff.owner')} required>
                    <Select aria-label={`${t('pilot.signoff.owner')} ${item.key}`} value={entry.role} onChange={(_, d) => setEntry(item.key, { role: d.value })}>
                      <option value="">{t('pilot.signoff.ownerChoose')}</option>
                      {ownerRoles.map((role) => (
                        <option key={role} value={role}>
                          {t(`pilot.signoff.roles.${role.replace('Crm.', '')}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </fieldset>
            );
          })}
        </div>
      )}

      <div className={styles.stack} style={{ marginTop: 16 }}>
        <Field
          label={t('pilot.signoff.fallback')}
          hint={t('pilot.signoff.counter', { length: fallback.trim().length, min: FALLBACK_MIN, max: FALLBACK_MAX })}
          validationState={fallback !== '' && !lengthOk(fallback, FALLBACK_MIN, FALLBACK_MAX) ? 'error' : 'none'}
          validationMessage={fallback !== '' && !lengthOk(fallback, FALLBACK_MIN, FALLBACK_MAX) ? t('pilot.signoff.lengthRule', { min: FALLBACK_MIN, max: FALLBACK_MAX }) : undefined}
          required
        >
          <Textarea value={fallback} maxLength={FALLBACK_MAX} resize="vertical" rows={3} onChange={(_, d) => setFallback(d.value)} />
        </Field>
        <Checkbox
          checked={statementOk}
          disabled={statement === ''}
          label={statement || t('common.loading')}
          onChange={(_, d) => setConfirmed(d.checked ? statement : null)}
        />
        <div className={styles.actions}>
          <Button appearance="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {signoff.isPending ? t('common.loading') : t('pilot.signoff.submit')}
          </Button>
        </div>
      </div>

      <div role="alert">
        {error && (
          <MessageBar intent="error" layout="multiline" style={{ marginTop: 12 }}>
            <MessageBarBody>
              {error.status === 412 ? t('pilot.signoff.changed') : error.message}
              {error.code === 'BIL_PILOT_COMPARISON_STALE' && <> {t('pilot.signoff.compareAgain')}</>}
              {error.keys.length > 0 && (
                <ul className={styles.list} aria-label={t('pilot.signoff.missingKeys')}>
                  {error.keys.map((key) => (
                    <li key={key} className={styles.mono}>
                      {key}
                    </li>
                  ))}
                </ul>
              )}
            </MessageBarBody>
            {(error.status === 412 || error.code === 'BIL_PILOT_COMPARISON_STALE') && (
              <MessageBarActions>
                <Button size="small" onClick={onReload}>
                  {t('pilot.signoff.reload')}
                </Button>
              </MessageBarActions>
            )}
          </MessageBar>
        )}
      </div>
      <UnsavedChangesDialog blocker={blocker} />
    </Panel>
  );
}
