import { useRef, useState } from 'react';
import { Button, Field, MessageBar, MessageBarBody, Textarea, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { AppLink } from '../../../shared/components/AppLink';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { useMigrationImport, type MigrationResult } from './api';
import { ResultView } from './ResultView';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalL },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  hint: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** One customers file: previewed first, then imported with the hash of that preview so another text is refused. */
export function ImportPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const run = useMigrationImport();
  const busy = useRef(false);
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<MigrationResult | null>(null);
  // The text that was previewed and the hash the server computed: only that same text may be imported.
  const [previewed, setPreviewed] = useState<{ text: string; sha: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const changeText = (text: string) => {
    setCsv(text);
    setResult(null);
    setPreviewed(null);
    setError(null);
  };

  const submit = async (dryRun: boolean) => {
    // A second click while the first request is on its way does nothing: an import must not start twice.
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const answer = await run.mutateAsync({ csv, dryRun, expectedSha256: dryRun ? undefined : previewed?.sha });
      setResult(answer);
      if (dryRun) setPreviewed({ text: csv, sha: answer.sourceSha256 });
      else if (answer.status === 'Completed' && !answer.repeated) notify(t('migration.imported', { created: answer.created, updated: answer.updated }));
    } catch (e) {
      const message = errorMessage(e, t);
      setError(message);
      if (e instanceof ApiError && e.code === 'IMPORT_SOURCE_CHANGED') setPreviewed(null);
      notify(t('migration.failed'), 'error', message);
    } finally {
      busy.current = false;
    }
  };

  const isResume = result?.mode === 'Real' && (result.status === 'Partial' || result.status === 'Failed');
  // Only the previewed text may be imported; after a finished import the file is previewed again to repeat it.
  const canImport = previewed !== null && previewed.text === csv && result !== null && (result.mode === 'DryRun' || isResume);

  return (
    <>
      <div className={styles.form}>
        <Field label={t('migration.file')}>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label={t('migration.file')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then(changeText);
            }}
          />
        </Field>
        <Field label={t('migration.paste')} hint={t('migration.columns')}>
          <Textarea value={csv} onChange={(_, d) => changeText(d.value)} resize="vertical" rows={8} />
        </Field>
        <div className={styles.actions}>
          <Button appearance="primary" disabled={!csv.trim() || run.isPending} onClick={() => void submit(true)}>
            {t('migration.preview')}
          </Button>
          <Button disabled={!csv.trim() || run.isPending || !canImport} onClick={() => void submit(false)}>
            {isResume ? t('migration.continue') : t('migration.import')}
          </Button>
        </div>
        <span className={styles.hint}>{previewed && previewed.text === csv ? t('migration.readyToImport') : t('migration.previewFirst')}</span>
      </div>

      <div role="alert">
        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
      </div>

      <div aria-live="polite">
        {run.isPending && <span className={styles.hint}>{t('common.loading')}</span>}
        {result && (
          <>
            <ResultView
              result={result}
              onContinue={previewed?.text === csv ? () => void submit(false) : undefined}
              continuing={run.isPending}
            />
            <p>
              <AppLink to={`/admin/migration?tab=runs&run=${result.runId}`}>{t('migration.openRun')}</AppLink>
            </p>
          </>
        )}
      </div>
    </>
  );
}
