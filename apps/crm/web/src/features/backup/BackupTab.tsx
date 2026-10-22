import { useEffect, useRef, useState } from 'react';
import {
  Badge, Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, MessageBar, MessageBarBody, SearchBox, Text, makeStyles, mergeClasses,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { CloudArchive16Regular, CloudArchive24Regular, History16Regular, MoreHorizontal20Regular, PeopleList16Regular, PeopleList24Regular, Warning16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { Panel } from '../../shared/components/Panel';
import { FilterChips, FilterField, Toolbar } from '../../shared/components/Toolbar';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { useFlushStyles } from '../billing/flushStyles';
import { ActionList } from '../actions/ActionLog';
import { FigureGrid } from '../reports/FigureGrid';
import { AlertReadLine } from '../service/alerts/AlertReadLine';
import { SavedServiceReadState } from '../service/SavedServiceReadState';
import { useBackupEntities, useBackupOverview, useCloudAllyLinked } from './api';
import { accountRequest, useBackupActions } from './backupActions';
import { BackupActionsHost } from './BackupActionsHost';
import { BackupEntityRow, BackupTaskRow } from './BackupRows';
import { serviceName, serviceOrder, serviceProblems } from './backupText';
import type { BackupLicences, BackupOverview, BackupService } from './types';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  mirror: { display: 'block', maxWidth: '75ch', marginBottom: '10px', color: h.muted, fontSize: '13px', lineHeight: '20px' },
  summary: { display: 'grid', gap: '12px' },
  facts: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))' },
  bad: { color: h.emberT }, warning: { color: h.saffronT }, good: { color: h.spruceT },
  account: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', fontSize: '13px', lineHeight: '20px', color: h.muted },
  accountName: { color: h.text, fontWeight: 600 },
  pad: { paddingLeft: '20px', paddingRight: '20px', '@media (max-width: 600px)': { paddingLeft: '16px', paddingRight: '16px' } },
  padEnd: { paddingBottom: '16px' },
  toolbar: { marginBottom: '4px' },
});

/** The customer's Sikkerhetskopi tab (M42): the saved copy of CloudAlly, with a lifetime per employee, rights and customer. */
export function BackupTab({ organizationId }: { organizationId: string }) {
  const user = useCurrentUser();
  if (!user.permissions.includes(Permissions.serviceRead)) return null;
  const owner = JSON.stringify([user.id, [...user.permissions].sort(), organizationId]);
  return <BackupActionsHost><SavedBackup key={owner} organizationId={organizationId} owner={owner} /></BackupActionsHost>;
}

type StateFilter = 'all' | 'problems';

function SavedBackup({ organizationId, owner }: { organizationId: string; owner: string }) {
  const styles = useStyles(); const flush = useFlushStyles(); const { t } = useTranslation();
  const [revision, setRevision] = useState(0); const refreshing = useRef(false); const scope = { owner, revision };
  const [state, setState] = useState<StateFilter>('all');
  const [service, setService] = useState<'' | BackupService>('');
  const [search, setSearch] = useState(''); const debounced = useDebouncedValue(search.trim());
  const overview = useBackupOverview(organizationId, scope);
  const linkRead = useCloudAllyLinked(organizationId, scope);
  const actions = useBackupActions(); const canWrite = useCan(Permissions.serviceWrite);
  const entities = useBackupEntities(organizationId, { service: service || undefined, state: state === 'all' ? undefined : state, q: debounced || undefined }, scope);
  const checking = overview.isFetching || entities.checking;
  useEffect(() => { if (!checking) refreshing.current = false; }, [checking, revision]);
  const refresh = () => { if (checking || refreshing.current) return; refreshing.current = true; setRevision((value) => value + 1); };
  const data = overview.isSuccess && !overview.isFetching ? overview.data : undefined;
  const linked = data !== undefined && data.accounts.length > 0;
  const services = data ? [...data.services].sort((a, b) => serviceOrder[a.service] - serviceOrder[b.service]) : [];
  const problems = services.reduce((sum, s) => sum + s.failed + s.late + s.paused + s.notInBackup, 0);
  const filtered = state !== 'all' || service !== '' || debounced !== '';

  return <div className={styles.stack}>
    <Panel title={t('backup.title')} icon={<CloudArchive16Regular />}
      actions={<Button size="small" disabled={checking} disabledFocusable={checking} onClick={refresh}>{t('service.refreshSaved')}</Button>}>
      <Text className={styles.mirror}>{t('backup.mirror')}</Text>
      <section aria-label={t('backup.summary')} className={styles.summary}>
        <SavedServiceReadState checking={overview.isFetching} error={overview.error} onRetry={() => void overview.refetch()} />
        {data && <AlertReadLine reads={[data.read]} />}
        {data && !linked && !linkRead.isPending && (linkRead.data
          ? <EmptyState icon={<CloudArchive24Regular />} message={t('backup.notReadYet')} />
          : <NoAccount />)}
        {data && linked && <>
          {services.length > 0
            ? <FigureGrid className={styles.facts} items={services.map((s) => ({
              label: serviceName(t, s.service),
              value: formatNumber(s.total, 0),
              note: <ServiceNote problems={serviceProblems(t, s)} failed={s.failed > 0} />,
            }))} />
            : <Text block>{t('backup.noTasks')}</Text>}
          <Licences licences={data.licences} />
          <Accounts overview={data} />
          {/* Nothing to click is not a fault of the screen: say that this installation keeps CloudAlly read-only. */}
          {canWrite && actions.kinds.size === 0 && <Text className={styles.mirror}>{t('backup.actionsOff')}</Text>}
        </>}
      </section>
    </Panel>

    {linked && <Panel title={t('backup.tasks.title')} icon={<CloudArchive16Regular />} flush className={flush.panel}>
      <ul className={flush.list}>{data.tasks.map((task) => <BackupTaskRow key={task.id} task={task} showAccount={data.accounts.length > 1} />)}</ul>
      {data.tasks.length === 0 && <EmptyState compact icon={<CloudArchive24Regular />} message={t('backup.noTasks')} />}
    </Panel>}

    {linked && <Panel title={t('backup.entities.title')} icon={<PeopleList16Regular />} flush className={flush.panel}>
      <div className={styles.pad}>
        <Toolbar label={t('backup.entities.filters')} className={styles.toolbar}>
          <FilterField kind="search" label={t('backup.entities.search')}>
            <SearchBox value={search} onChange={(_, d) => setSearch(d.value)} placeholder={t('backup.entities.search')} />
          </FilterField>
          <FilterChips<StateFilter> label={t('backup.entities.stateLabel')} value={state} onChange={setState}
            options={[{ value: 'all', label: t('backup.entities.all') }, { value: 'problems', label: t('backup.entities.problems'), count: problems }]} />
          <FilterChips<'' | BackupService> label={t('backup.entities.serviceLabel')} value={service} onChange={setService}
            options={[{ value: '', label: t('backup.entities.allServices') }, ...services.map((s) => ({ value: s.service, label: serviceName(t, s.service) }))]} />
        </Toolbar>
      </div>
      <div className={mergeClasses(styles.pad, !entities.available && styles.padEnd)}>
        <SavedServiceReadState checking={entities.checking} error={entities.error} onRetry={entities.refresh} />
      </div>
      <ul className={flush.list}>{entities.items.map((entity) => <BackupEntityRow key={entity.id} entity={entity} />)}</ul>
      {entities.available && entities.items.length === 0 && <EmptyState compact icon={<PeopleList24Regular />}
        message={t(filtered ? (state === 'problems' && service === '' && debounced === '' ? 'backup.entities.noProblems' : 'backup.entities.noMatch') : 'backup.entities.none')} />}
      <ListFooter shown={entities.items.length} total={entities.total} hasMore={entities.hasNextPage} loading={entities.isFetchingNextPage}
        onMore={() => void entities.fetchNextPage()} />
    </Panel>}

    {/* What was asked of CloudAlly for this customer, by whom and how it ended: a restore is followed up here, not only in its dialog. */}
    {linked && <Panel title={t('backup.actionsLog.title')} icon={<History16Regular />} flush className={flush.panel}>
      <ActionList filters={{ system: 'cloudally', organizationId }} limit={5} empty={t('backup.actionsLog.none')} />
    </Panel>}
  </div>;
}

/** A service's note under its count: its problems in the tone of the worst (a failure red, the rest amber), or that all is well. */
function ServiceNote({ problems, failed }: { problems: string | null; failed: boolean }) {
  const styles = useStyles(); const { t } = useTranslation();
  return problems ? <span className={failed ? styles.bad : styles.warning}>{problems}</span> : <span className={styles.good}>{t('backup.allOk')}</span>;
}

/** The customer has no CloudAlly account linked: the tab says so, and whoever links accounts gets the way there. */
function NoAccount() {
  const { t } = useTranslation(); const canLink = useCan(Permissions.integrationsManage);
  return <EmptyState icon={<CloudArchive24Regular />} message={t('backup.noAccount')}
    action={canLink ? <AppLink to="/admin/mappings?system=cloudally&type=Customer">{t('backup.linkAccount')}</AppLink> : undefined} />;
}

/**
 * The check of licensed users: how many of the customer's users hold a Microsoft 365 licence with a mailbox (Partner Center) and how
 * many mailboxes are in the backup — or, without a licence reading, that nothing can be said.
 */
function Licences({ licences }: { licences: BackupLicences }) {
  const { t } = useTranslation();
  if (licences.state === 'NoAccount') return null;
  if (licences.state === 'NoData') {
    return <MessageBar intent="info"><MessageBarBody>{t('backup.licences.noData')}</MessageBarBody></MessageBar>;
  }

  const values = { licensed: licences.licensed ?? 0, backedUp: licences.backedUp, missing: licences.missing ?? 0, date: formatDate(licences.readOn) };
  if (values.licensed === 0) {
    return <MessageBar intent="info"><MessageBarBody>{t('backup.licences.noMailboxLicences', values)}</MessageBarBody></MessageBar>;
  }

  return values.missing > 0
    ? <MessageBar intent="warning"><MessageBarBody>{t('backup.licences.missing', { ...values, count: values.missing })}</MessageBarBody></MessageBar>
    : <MessageBar intent="success"><MessageBarBody>{t('backup.licences.allIn', { ...values, count: values.licensed })}</MessageBarBody></MessageBar>;
}

/** The customer's CloudAlly accounts: name, data center (marked when outside the EU) and the way to close one. */
function Accounts({ overview }: { overview: BackupOverview }) {
  const styles = useStyles(); const { t } = useTranslation(); const restore = useRestoreFocusTarget();
  const actions = useBackupActions();
  const close = actions.kinds.has('account.deactivate');
  return <>{overview.accounts.map((account) => <div key={account.id} className={styles.account}>
    <span>{t('backup.account')} <span className={styles.accountName}>{account.name}</span></span>
    {account.region && <span>· {t('backup.region', { region: account.region })}</span>}
    {account.outsideRegion && <Badge appearance="tint" color="warning" icon={<Warning16Regular />}>{t('backup.outsideRegion')}</Badge>}
    {close && <Menu positioning="below-end">
      <MenuTrigger disableButtonEnhancement>
        <Button {...restore} size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={t('backup.accountMenu', { name: account.name })} />
      </MenuTrigger>
      <MenuPopover><MenuList>
        <MenuItem onClick={() => actions.ask(accountRequest(account))}>{t('backup.actions.account.deactivate.item')}</MenuItem>
      </MenuList></MenuPopover>
    </Menu>}
  </div>)}</>;
}
