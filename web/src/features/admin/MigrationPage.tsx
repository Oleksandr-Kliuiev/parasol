import { useState } from 'react';
import {
  Badge,
  Button,
  Field,
  MessageBar,
  MessageBarBody,
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
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AppLink } from '../../shared/components/AppLink';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { postCsv } from '../licensing/api';
import { useCatalogStyles } from '../catalog/styles';

interface MigrationRow {
  line: number;
  name: string;
  orgNumber: string | null;
  action: 'Created' | 'Updated' | 'Unchanged' | 'Conflict' | 'Failed';
  detail: string | null;
  organizationId: string | null;
}

interface MigrationResult {
  created: number;
  updated: number;
  unchanged: number;
  contacts: number;
  conflicts: number;
  failed: number;
  rows: MigrationRow[];
  warnings: string[];
}

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginBottom: tokens.spacingVerticalL },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS },
  tiles: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalL, marginBottom: tokens.spacingVerticalM },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

const actionColor = (action: MigrationRow['action']) =>
  action === 'Created' ? 'success' : action === 'Updated' ? 'brand' : action === 'Conflict' ? 'warning' : action === 'Failed' ? 'danger' : 'subtle';

/** Data migration from the old systems (ТЗ §6.6): one file of customers, previewed before anything is written. */
export function MigrationPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<MigrationResult | null>(null);
  const [previewed, setPreviewed] = useState(false);

  const run = useMutation({
    mutationFn: ({ text, dryRun }: { text: string; dryRun: boolean }) =>
      postCsv<MigrationResult>(`/api/v1/customers/organizations/import?dryRun=${dryRun}`, text),
  });

  const submit = async (dryRun: boolean) => {
    try {
      const result = await run.mutateAsync({ text: csv, dryRun });
      setPreview(result);
      setPreviewed(dryRun);
      if (!dryRun) notify(t('migration.imported', { created: result.created, updated: result.updated }));
    } catch (e) {
      notify(t('migration.failed'), 'error', errorMessage(e, t));
    }
  };

  return (
    <>
      <PageHeader title={t('migration.title')} subtitle={t('migration.subtitle')} />

      <div className={styles.form}>
        <Field label={t('migration.file')}>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label={t('migration.file')}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void file.text().then((text) => { setCsv(text); setPreview(null); });
            }}
          />
        </Field>
        <Field label={t('migration.paste')} hint={t('migration.columns')}>
          <Textarea value={csv} onChange={(_, d) => { setCsv(d.value); setPreview(null); }} resize="vertical" rows={8} />
        </Field>
        <div className={styles.actions}>
          <Button appearance="primary" disabled={!csv.trim() || run.isPending} onClick={() => void submit(true)}>
            {t('migration.preview')}
          </Button>
          <Button disabled={!csv.trim() || run.isPending || !previewed} onClick={() => void submit(false)}>
            {t('migration.import')}
          </Button>
        </div>
      </div>

      {run.error && (
        <MessageBar intent="error">
          <MessageBarBody>{errorMessage(run.error, t)}</MessageBarBody>
        </MessageBar>
      )}

      {preview && (
        <>
          <div className={styles.tiles}>
            <Text>{t('migration.summary', { created: preview.created, updated: preview.updated, unchanged: preview.unchanged })}</Text>
            <Text>{t('migration.contacts', { count: preview.contacts })}</Text>
            {preview.conflicts > 0 && <Text>{t('migration.conflicts', { count: preview.conflicts })}</Text>}
            {preview.failed > 0 && <Text>{t('migration.failedRows', { count: preview.failed })}</Text>}
          </div>

          {preview.warnings.length > 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>{preview.warnings.join(' ')}</MessageBarBody>
            </MessageBar>
          )}

          <div className={catalog.tableWrap} style={{ marginTop: 12 }}>
            <Table className={catalog.table} aria-label={t('migration.title')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell className={catalog.number}>{t('migration.fields.line')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.customer')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.action')}</TableHeaderCell>
                  <TableHeaderCell>{t('migration.fields.detail')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.rows.map((row) => (
                  <TableRow key={`${row.line}-${row.name}`}>
                    <TableCell className={catalog.number}>{row.line}</TableCell>
                    <TableCell>
                      {row.organizationId && !previewed ? (
                        <AppLink to={`/organizations/${row.organizationId}`}>{row.name}</AppLink>
                      ) : (
                        <span className={catalog.name}>{row.name}</span>
                      )}
                      {row.orgNumber && <div className={catalog.sku}>{row.orgNumber}</div>}
                    </TableCell>
                    <TableCell>
                      <Badge appearance="outline" color={actionColor(row.action)}>
                        {t(`migration.actions.${row.action}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className={styles.muted}>{row.detail ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {preview.created + preview.updated + preview.conflicts + preview.failed > preview.rows.length && (
            <Text className={styles.muted}>
              {t('migration.rowsShown', { shown: preview.rows.length, total: preview.created + preview.updated + preview.conflicts + preview.failed })}
            </Text>
          )}
        </>
      )}
    </>
  );
}
