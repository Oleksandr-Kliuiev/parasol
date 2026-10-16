import { useRef, useState } from 'react';
import { Button, Field, MessageBar, MessageBarBody, Textarea } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Panel } from '../../../shared/components/Panel';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { useCompare, type ComparisonResult } from './api';
import { CSV_HEADER } from './constants';
import { usePilotStyles } from './styles';

/** The independent calculation of the old method, uploaded or pasted and set against the run; nothing is written to billing. */
export function ComparePanel({ runId, onResult }: { runId: string; onResult: (result: ComparisonResult) => void }) {
  const styles = usePilotStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const compare = useCompare(runId);
  const busy = useRef(false);
  const [csv, setCsv] = useState('');
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
    <Panel title={t('pilot.compare.title')}>
      <p style={{ marginTop: 0 }}>{t('pilot.compare.intro')}</p>
      <p className={styles.muted}>
        {t('pilot.compare.format')} <code className={styles.mono}>{CSV_HEADER}</code>
      </p>
      <p className={styles.muted}>{t('pilot.compare.coverage')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label={t('pilot.compare.file')}>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label={t('pilot.compare.file')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then((text) => setCsv(text));
            }}
          />
        </Field>
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
          <MessageBar intent="error" style={{ marginTop: 12 }}>
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
      </div>
    </Panel>
  );
}
