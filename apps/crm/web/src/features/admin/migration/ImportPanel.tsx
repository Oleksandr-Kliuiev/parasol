import { useRef, useState } from 'react';
import { Button, Field, MessageBar, MessageBarBody, Spinner, Textarea, mergeClasses } from '@fluentui/react-components';
import { ArrowUpload16Regular, CheckmarkCircle16Regular, Info16Regular, DocumentSearch16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { AppLink } from '../../../shared/components/AppLink';
import { Panel } from '../../../shared/components/Panel';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { useMigrationImport, type MigrationResult } from './api';
import { ResultView } from './ResultView';
import { useMigrationStyles } from './styles';

/** One customers file: previewed first, then imported with the hash of that preview so another text is refused. */
export function ImportPanel() {
  const styles = useMigrationStyles();
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
  const empty = !csv.trim();
  // Why the next button cannot be used yet, or that it can: always on screen next to the buttons.
  const reason = run.isPending ? t('common.loading') : empty ? t('migration.emptyFirst') : canImport ? t('migration.readyToImport') : t('migration.previewFirst');

  return (
    <div className={styles.stack}>
      <Panel title={t('migration.importTitle')} icon={<ArrowUpload16Regular />}>
        <div className={styles.form}>
          <p className={styles.lead}>{t('migration.importLead')}</p>
          <Field label={t('migration.file')}>
            <input
              className={styles.file}
              type="file"
              accept=".csv,text/csv,text/plain"
              aria-label={t('migration.file')}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void file.text().then(changeText);
              }}
            />
          </Field>
          <Field label={t('migration.paste')} hint={{ children: t('migration.columns'), className: styles.hint }} className={styles.csv}>
            <Textarea value={csv} onChange={(_, d) => changeText(d.value)} resize="vertical" rows={6} />
          </Field>
          <div className={styles.footer}>
            <div className={mergeClasses(styles.reason, canImport && !run.isPending && styles.ready)} aria-live="polite">
              <span className={mergeClasses(styles.reasonIcon, canImport && !run.isPending && styles.ready)} aria-hidden>
                {run.isPending ? <Spinner size="extra-tiny" /> : canImport ? <CheckmarkCircle16Regular /> : <Info16Regular />}
              </span>
              {reason}
            </div>
            <div className={styles.actions}>
              {/* The order of the work: preview first, then the import of exactly that text, which then becomes the main action. */}
              <Button
                appearance={canImport ? 'secondary' : 'primary'}
                icon={<DocumentSearch16Regular />}
                disabled={empty || run.isPending}
                onClick={() => void submit(true)}
              >
                {t('migration.preview')}
              </Button>
              <Button appearance={canImport ? 'primary' : 'secondary'} disabled={empty || run.isPending || !canImport} onClick={() => void submit(false)}>
                {isResume ? t('migration.continue') : t('migration.import')}
              </Button>
            </div>
          </div>
        </div>
      </Panel>

      <div role="alert">
        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
      </div>

      <div aria-live="polite">
        {result && (
          <Panel
            title={result.mode === 'Real' ? t('migration.resultImport') : t('migration.resultPreview')}
            icon={<DocumentSearch16Regular />}
            actions={
              <AppLink to={`/admin/migration?tab=runs&run=${result.runId}`}>{t('migration.openRun')}</AppLink>
            }
          >
            <ResultView result={result} onContinue={previewed?.text === csv ? () => void submit(false) : undefined} continuing={run.isPending} />
          </Panel>
        )}
      </div>
    </div>
  );
}
