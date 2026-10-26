import { Tab, makeStyles } from '@fluentui/react-components';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../shared/components/PageHeader';
import { ImportPanel } from './migration/ImportPanel';
import { ReconciliationPanel } from './migration/ReconciliationPanel';
import { RunsPanel } from './migration/RunsPanel';
import { ScrollTabList } from '../../shared/components/ScrollTabList';

const useStyles = makeStyles({
  // The segmented control of the visual system; it scrolls sideways when the labels do not fit a phone.
  tabs: { marginBottom: '20px', overflowX: 'auto', overflowY: 'hidden', scrollPaddingInline: '16px' },
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
      <PageHeader
        title={t('migration.title')}
        subtitle={t('migration.subtitle')}
        back={tab === 'runs' && runId ? { to: '/admin/migration?tab=runs', label: t('migration.runs.back') } : undefined}
      />
      <ScrollTabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setParams(d.value === 'import' ? {} : { tab: String(d.value) }, { replace: true })}
      >
        <Tab value="import">{t('migration.tabs.import')}</Tab>
        <Tab value="runs">{t('migration.tabs.runs')}</Tab>
        <Tab value="reconcile">{t('migration.tabs.reconcile')}</Tab>
      </ScrollTabList>
      {tab === 'import' && <ImportPanel />}
      {tab === 'runs' && <RunsPanel runId={runId} onOpen={(id) => setParams(id ? { tab: 'runs', run: id } : { tab: 'runs' })} />}
      {tab === 'reconcile' && <ReconciliationPanel />}
    </>
  );
}
