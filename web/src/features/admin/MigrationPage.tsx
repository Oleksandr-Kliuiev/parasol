import { Tab, TabList, makeStyles, tokens } from '@fluentui/react-components';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../shared/components/PageHeader';
import { ImportPanel } from './migration/ImportPanel';
import { ReconciliationPanel } from './migration/ReconciliationPanel';
import { RunsPanel } from './migration/RunsPanel';

const useStyles = makeStyles({
  tabs: { marginBottom: tokens.spacingVerticalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
});

type TabKey = 'import' | 'runs' | 'reconcile';

/** Data migration from the old systems (ТЗ §6.6, DEV-20): preview, import, the history of runs and the cutover reconciliation. */
export function MigrationPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab: TabKey = params.get('tab') === 'runs' ? 'runs' : params.get('tab') === 'reconcile' ? 'reconcile' : 'import';
  const runId = params.get('run');

  return (
    <>
      <PageHeader title={t('migration.title')} subtitle={t('migration.subtitle')} />
      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setParams(d.value === 'import' ? {} : { tab: String(d.value) }, { replace: true })}
      >
        <Tab value="import">{t('migration.tabs.import')}</Tab>
        <Tab value="runs">{t('migration.tabs.runs')}</Tab>
        <Tab value="reconcile">{t('migration.tabs.reconcile')}</Tab>
      </TabList>
      {tab === 'import' && <ImportPanel />}
      {tab === 'runs' && <RunsPanel runId={runId} onOpen={(id) => setParams(id ? { tab: 'runs', run: id } : { tab: 'runs' })} />}
      {tab === 'reconcile' && <ReconciliationPanel />}
    </>
  );
}
