import { Spinner, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, mergeClasses } from '@fluentui/react-components';
import { CheckmarkCircle20Regular, ShieldError20Regular, ShieldTask16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ErrorState } from '../../../shared/components/ErrorState';
import { Panel } from '../../../shared/components/Panel';
import { useReadiness, type Readiness, type ReadinessCheck } from './api';
import { ScrollRegion } from './parts';
import { usePilotStyles } from './styles';

/** Plain text states: ok / attention / unknown. Colour only supports the words. */
function CheckState({ check }: { check: ReadinessCheck }) {
  const styles = usePilotStyles();
  const { t } = useTranslation();
  if (check.ok === null) return <Text className={styles.neutral}>{t('pilot.readiness.unknown')}</Text>;
  if (check.ok) return <Text className={styles.good}>{t('pilot.readiness.ok')}</Text>;
  return <Text className={check.decisive ? styles.bad : styles.warn}>{check.decisive ? t('pilot.readiness.blocks') : t('pilot.readiness.attention')}</Text>;
}

/** The result of the probe, separate from the query so it can be rendered from a fixture. */
export function ReadinessView({ readiness }: { readiness: Readiness }) {
  const styles = usePilotStyles();
  const { t } = useTranslation();
  return (
    <>
      <p role="status" className={mergeClasses(styles.verdict, readiness.safeForParallelRun ? styles.verdictGood : styles.verdictBad)}>
        {readiness.safeForParallelRun ? <CheckmarkCircle20Regular aria-hidden /> : <ShieldError20Regular aria-hidden />}
        <span>{readiness.safeForParallelRun ? t('pilot.readiness.safe') : t('pilot.readiness.notSafe')}</span>
      </p>
      <p className={styles.lead}>{t('pilot.readiness.source', { source: readiness.source })}</p>
      <ScrollRegion label={t('pilot.readiness.tableLabel')}>
        <Table className={styles.table} aria-label={t('pilot.readiness.tableLabel')}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ width: '28%' }}>{t('pilot.readiness.check')}</TableHeaderCell>
              <TableHeaderCell style={{ width: 140 }}>{t('pilot.readiness.value')}</TableHeaderCell>
              <TableHeaderCell style={{ width: 128 }}>{t('common.status')}</TableHeaderCell>
              <TableHeaderCell>{t('pilot.readiness.explanation')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {readiness.checks.map((check) => (
              <TableRow key={check.check}>
                <TableCell>
                  <span className={styles.neutral}>{t(`pilot.readiness.names.${check.check.replace('.', '_')}`, { defaultValue: check.check })}</span>
                  {check.decisive && <div className={styles.muted}>{t('pilot.readiness.decisive')}</div>}
                </TableCell>
                <TableCell className={styles.key}>{check.state}</TableCell>
                <TableCell>
                  <CheckState check={check} />
                </TableCell>
                <TableCell>{t(`pilot.readiness.codes.${check.code}`, { defaultValue: check.code })}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollRegion>
      <div className={styles.well}>
        <h3 className={styles.wellHeading}>{t('pilot.readiness.caveatsTitle')}</h3>
        <ul className={styles.list}>
          <li>{t('pilot.readiness.workerFacts')}</li>
          {readiness.caveats.map((code) => (
            <li key={code}>{t(`pilot.readiness.caveats.${code}`, { defaultValue: code })}</li>
          ))}
        </ul>
      </div>
    </>
  );
}

/** Whether a parallel pilot month can run without anything leaving the company, as far as crm-web can know. */
export function ReadinessPanel({ period }: { period: string }) {
  const { t } = useTranslation();
  const readiness = useReadiness(period);
  return (
    <Panel title={t('pilot.readiness.title')} icon={<ShieldTask16Regular />}>
      {readiness.isPending ? (
        <Spinner size="small" label={t('common.loading')} />
      ) : readiness.error ? (
        <ErrorState error={readiness.error} onRetry={() => void readiness.refetch()} />
      ) : (
        <ReadinessView readiness={readiness.data} />
      )}
    </Panel>
  );
}
