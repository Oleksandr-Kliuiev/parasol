import { useId, useRef, useState } from 'react';
import { Button, Field, Input, MessageBar, MessageBarBody, Select, Tab, TabList, Text } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { severities, type WorkspaceSummary } from './workspaceContract';
import { ObservationQueue } from './ObservationQueue';
import { ObservationRows } from './ObservationRows';
import { useTechnicalStyles } from './technicalStyles';

const batch = 25;

export function CustomerTechnicalDetails({ customerId, summary, onSourceInvalidated }: {
  customerId: string; summary: WorkspaceSummary; onSourceInvalidated: () => void;
}) {
  const { t } = useTranslation();
  const styles = useTechnicalStyles();
  const [active, setActive] = useState('observations');
  const queueTab = useRef<HTMLButtonElement>(null);
  const id = useId();
  return <>
    <TabList className={styles.tabs} aria-label={t('parasolDetails.lists')} selectedValue={active} onTabSelect={(_, d) => setActive(String(d.value))}>
      <Tab id={`${id}-observations-tab`} aria-controls={`${id}-observations`} value="observations">{t('parasolDetails.observations')}</Tab>
      <Tab id={`${id}-devices-tab`} aria-controls={`${id}-devices`} value="devices">{t('parasolDetails.devices')}</Tab>
      <Tab ref={queueTab} id={`${id}-queue-tab`} aria-controls={`${id}-queue`} value="queue">{t('parasolQueue.title')}</Tab>
    </TabList>
    <div role="tabpanel" id={`${id}-${active}`} aria-labelledby={`${id}-${active}-tab`}>
      {active === 'queue' ? <ObservationQueue customerId={customerId} onSourceInvalidated={onSourceInvalidated} />
        : active === 'devices' ? <DeviceList devices={summary.devices} /> : <ObservationList summary={summary} openQueue={() => {
          setActive('queue'); queueTab.current?.focus();
        }} />}
    </div>
  </>;
}

function DeviceList({ devices }: { devices: WorkspaceSummary['devices'] }) {
  const { t } = useTranslation();
  const styles = useTechnicalStyles();
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

function ObservationList({ summary, openQueue }: { summary: WorkspaceSummary; openQueue: () => void }) {
  const { t } = useTranslation();
  const styles = useTechnicalStyles();
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
      <Button onClick={openQueue}>{t('parasolQueue.open')}</Button>
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
      <ObservationRows items={matches.slice(0, limit)} devices={summary.devices} />
      <div className={styles.footer}>
        <Text>{t('parasolDetails.visible', { shown: Math.min(limit, matches.length), total: matches.length })}</Text>
        {matches.length > limit && <Button onClick={() => setLimit(n => n + batch)}>{t('parasolDetails.moreObservations')}</Button>}
      </div>
    </>}
  </section>;
}
