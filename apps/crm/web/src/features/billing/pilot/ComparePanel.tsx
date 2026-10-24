import { useId, useRef, useState } from 'react';
import { Button, Field, MessageBar, MessageBarBody, Textarea, makeStyles } from '@fluentui/react-components';
import { ArrowUpload20Regular, DataHistogram16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { Panel } from '../../../shared/components/Panel';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { useCompare, type ComparisonResult } from './api';
import { CSV_HEADER } from './constants';
import { usePilotStyles } from './styles';

const useStyles = makeStyles({
  form: { display: 'grid', gap: '14px' },
  // The header row the file starts with, as a code chip the eye can copy.
  format: { display: 'grid', gap: '6px', paddingTop: '12px', paddingBottom: '12px', paddingLeft: '14px', paddingRight: '14px', borderRadius: '12px', backgroundColor: h.well },
  code: { justifySelf: 'start', maxWidth: '100%', paddingTop: '2px', paddingBottom: '2px', paddingLeft: '8px', paddingRight: '8px', borderRadius: '8px', backgroundColor: h.surface, border: `1px solid ${h.line}`, overflowWrap: 'anywhere' },
  // The file picker in the app's own words: a button and the chosen file's name; the native input stays for the keyboard.
  file: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px' },
  fileName: { color: h.muted, fontSize: '13px', overflowWrap: 'anywhere' },
  picker: { display: 'grid', gap: '6px' },
  label: { fontSize: '12.5px', lineHeight: '18px', fontWeight: 700 },
  hidden: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
  error: { marginTop: '12px' },
});

/** The independent calculation of the old method, uploaded or pasted and set against the run; nothing is written to billing. */
export function ComparePanel({ runId, onResult }: { runId: string; onResult: (result: ComparisonResult) => void }) {
  const styles = usePilotStyles();
  const local = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const compare = useCompare(runId);
  const busy = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileLabel = useId();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    // A second click while the first request is on its way does nothing.
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const answer = await compare.mutateAsync(csv);
      onResult(answer);
      notify(t('pilot.compare.done', { number: answer.comparison.exceptionCount }));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      busy.current = false;
    }
  };

  return (
    <Panel title={t('pilot.compare.title')} icon={<DataHistogram16Regular />}>
      <p className={styles.lead}>{t('pilot.compare.intro')}</p>
      <div className={local.form}>
        <div className={local.format}>
          <span className={styles.term}>{t('pilot.compare.format')}</span>
          <code className={`${styles.mono} ${local.code}`}>{CSV_HEADER}</code>
          <span className={styles.muted}>{t('pilot.compare.coverage')}</span>
        </div>
        <div className={local.picker}>
          <span id={fileLabel} className={local.label}>{t('pilot.compare.file')}</span>
          <div className={local.file}>
            {/* The native input does the work; the button opens it in the interface language, so it is kept out of the tab order. */}
            <input
              ref={fileInput}
              className={local.hidden}
              type="file"
              accept=".csv,text/csv,text/plain"
              tabIndex={-1}
              aria-hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  setFileName(file.name);
                  void file.text().then((text) => setCsv(text));
                }
              }}
            />
            <Button icon={<ArrowUpload20Regular />} aria-describedby={fileLabel} onClick={() => fileInput.current?.click()}>{t('pilot.compare.choose')}</Button>
            <span className={local.fileName} aria-live="polite">{fileName ?? t('pilot.compare.noFile')}</span>
          </div>
        </div>
        <Field label={t('pilot.compare.paste')}>
          <Textarea value={csv} onChange={(_, d) => setCsv(d.value)} resize="vertical" rows={6} />
        </Field>
        <div className={styles.actions}>
          <Button appearance="primary" disabled={!csv.trim() || compare.isPending} onClick={() => void submit()}>
            {compare.isPending ? t('common.loading') : t('pilot.compare.run')}
          </Button>
        </div>
      </div>
      <div role="alert">
        {error && (
          <MessageBar intent="error" className={local.error}>
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
      </div>
    </Panel>
  );
}
