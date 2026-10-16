import { useId, useState } from 'react';
import { Badge, Button, Field, Input, MessageBar, MessageBarBody, Select, Tab, TabList, Text, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../shared/utils/format';
import { severities, type WorkspaceSummary } from './workspaceContract';

const useStyles = makeStyles({
  tabs: { flexWrap: 'wrap', marginTop: tokens.spacingVerticalL },
  section: { marginTop: tokens.spacingVerticalXXL, minWidth: 0 },
  heading: { fontSize: tokens.fontSizeBase400, marginBlock: tokens.spacingVerticalM },
  tools: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: tokens.spacingHorizontalM,
    marginBlock: tokens.spacingVerticalM, minWidth: 0 },
  list: { listStyle: 'none', padding: 0, marginBlock: tokens.spacingVerticalM, display: 'grid', gap: tokens.spacingVerticalM },
  row: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalM,
    display: 'grid', gap: tokens.spacingVerticalS, minWidth: 0, overflowWrap: 'anywhere' },
  badges: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM },
});
const batch = 25;

export function CustomerTechnicalDetails({ summary }: { summary: WorkspaceSummary }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const [active, setActive] = useState('observations');
  const id = useId();
  return <>
    <TabList className={styles.tabs} aria-label={t('parasolDetails.lists')} selectedValue={active} onTabSelect={(_, d) => setActive(String(d.value))}>
      <Tab id={`${id}-observations-tab`} aria-controls={`${id}-observations`} value="observations">{t('parasolDetails.observations')}</Tab>
      <Tab id={`${id}-devices-tab`} aria-controls={`${id}-devices`} value="devices">{t('parasolDetails.devices')}</Tab>
    </TabList>
    <div role="tabpanel" id={`${id}-${active}`} aria-labelledby={`${id}-${active}-tab`}>
      {active === 'devices' ? <DeviceList devices={summary.devices} /> : <ObservationList summary={summary} />}
    </div>
  </>;
}

function DeviceList({ devices }: { devices: WorkspaceSummary['devices'] }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const heading = useId();
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(batch);
  const term = search.trim().toLocaleLowerCase();
  const matches = devices.filter(d => `${d.hostname} ${d.id}`.toLocaleLowerCase().includes(term));
  return <section className={styles.section} aria-labelledby={heading}>
    <h3 className={styles.heading} id={heading}>{t('parasolDetails.devices')}</h3>
    <Text block>{t('parasolDetails.deviceNote')}</Text>
    {devices.length === 0 ? <Text block role="status">{t('parasolDetails.noDevices')}</Text> : <>
      <div className={styles.tools}><Field label={t('parasolDetails.searchDevices')}>
        <Input type="search" value={search} maxLength={256} onChange={(_, d) => { setSearch(d.value); setLimit(batch); }} />
      </Field></div>
      <Text block role="status">{t('parasolDetails.deviceMatches', { matched: matches.length, loaded: devices.length })}</Text>
      {matches.length === 0 && <Text block>{t('parasolDetails.noMatches')}</Text>}
      <ul className={styles.list}>
        {matches.slice(0, limit).map(d => <li key={d.id} className={styles.row}>
          <Text weight="semibold">{d.hostname}</Text>
          <Text>{t('parasolDetails.deviceId')}: {d.id}</Text>
          <Text>{d.sources.length ? t('parasolDetails.deviceSources', { sources: d.sources.map(s => t(`parasol.sources.${s}`)).join(', ') })
            : t('parasolDetails.noDeviceSources')}</Text>
        </li>)}
      </ul>
      <div className={styles.footer}>
        <Text>{t('parasolDetails.visible', { shown: Math.min(limit, matches.length), total: matches.length })}</Text>
        {matches.length > limit && <Button onClick={() => setLimit(n => n + batch)}>{t('parasolDetails.moreDevices')}</Button>}
      </div>
    </>}
  </section>;
}

function ObservationList({ summary }: { summary: WorkspaceSummary }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const heading = useId();
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [limit, setLimit] = useState(batch);
  const term = search.trim().toLocaleLowerCase();
  const devices = new Map(summary.devices.map(d => [d.id, d.hostname]));
  const page = summary.observationPage;
  const matches = page.items.filter(o => (severity === 'ALL' || (severity === 'URGENT' ? o.priority === 'URGENT' : o.severity === severity))
    && (status === 'ALL' || o.status === status)
    && `${o.summary} ${o.id} ${o.deviceId ? devices.get(o.deviceId) ?? '' : ''}`.toLocaleLowerCase().includes(term));
  return <section className={styles.section} aria-labelledby={heading}>
    <h3 className={styles.heading} id={heading}>{t('parasolDetails.observations')}</h3>
    <Text block>{t('parasolDetails.observationNote')}</Text>
    {page.truncated && <MessageBar layout="multiline" intent="warning"><MessageBarBody>
      {t('parasolDetails.partialObservations', { loaded: page.items.length, total: summary.activeObservations })}
    </MessageBarBody></MessageBar>}
    {page.items.length === 0 ? <Text block role="status">{t('parasolDetails.noObservations')}</Text> : <>
      <div className={styles.tools}>
        <Field label={t('parasolDetails.searchObservations')}><Input type="search" value={search} maxLength={300}
          onChange={(_, d) => { setSearch(d.value); setLimit(batch); }} /></Field>
        <Field label={t('parasolDetails.severityFilter')}><Select value={severity} onChange={(_, d) => { setSeverity(d.value); setLimit(batch); }}>
          <option value="ALL">{t('parasolDetails.allSeverities')}</option>
          <option value="URGENT">{t('parasolDetails.urgent')}</option>
          {[...severities].reverse().map(s => <option key={s} value={s}>{t(`parasolDetails.severity.${s}`)}</option>)}
        </Select></Field>
        <Field label={t('parasolDetails.statusFilter')}><Select value={status} onChange={(_, d) => { setStatus(d.value); setLimit(batch); }}>
          <option value="ALL">{t('parasolDetails.allStatuses')}</option>
          <option value="OPEN">{t('parasolDetails.status.OPEN')}</option>
          <option value="ACKNOWLEDGED">{t('parasolDetails.status.ACKNOWLEDGED')}</option>
        </Select></Field>
      </div>
      <Text block role="status">{t('parasolDetails.observationMatches', { matched: matches.length, loaded: page.items.length })}</Text>
      {matches.length === 0 && <Text block>{t('parasolDetails.noMatches')}</Text>}
      <ul className={styles.list}>
        {matches.slice(0, limit).map(o => <li key={o.id} className={styles.row}>
          <div className={styles.badges}>
            <Badge appearance="tint" color={o.priority === 'URGENT' ? 'danger' : 'informative'}>{t(`parasolDetails.severity.${o.severity}`)}</Badge>
            {o.priority === 'URGENT' && <Text weight="semibold">{t('parasolDetails.urgent')}</Text>}
            <Text>{t(`parasolDetails.status.${o.status}`)}</Text>
          </div>
          <Text weight="semibold">{o.summary || t('parasolDetails.noSummary')}</Text>
          <Text>{t(`parasol.sources.${o.source}`)} · {t(`parasolDetails.kind.${o.kind}`)}</Text>
          <Text>{o.deviceId ? t('parasolDetails.confirmedDevice', { name: devices.get(o.deviceId), id: o.deviceId })
            : t(`parasolDetails.deviceStatus.${o.deviceStatus}`)}</Text>
          <Text>{t('parasolDetails.route')}: {t(`parasolDetails.routes.${o.route}`)}</Text>
          <Text>{t('parasolDetails.occurredAt', { time: formatDateTime(o.occurredAt) })}</Text>
          <Text>{t('parasolDetails.updatedAt', { time: formatDateTime(o.updatedAt) })}</Text>
        </li>)}
      </ul>
      <div className={styles.footer}>
        <Text>{t('parasolDetails.visible', { shown: Math.min(limit, matches.length), total: matches.length })}</Text>
        {matches.length > limit && <Button onClick={() => setLimit(n => n + batch)}>{t('parasolDetails.moreObservations')}</Button>}
      </div>
    </>}
  </section>;
}
