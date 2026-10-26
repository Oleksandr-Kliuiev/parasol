import { lazy, Suspense, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, Field, Input, MessageBar, MessageBarActions, MessageBarBody, Select, Spinner, Tab, TabList, Text, mergeClasses } from '@fluentui/react-components';
import { Search16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { severities, type WorkspaceSummary } from './workspaceContract';
import { ObservationQueue } from './ObservationQueue';
import { ObservationRows } from './ObservationRows';
import { useTechnicalStyles } from './technicalStyles';
import { AtlasDeviceList, deviceBatch } from './AtlasDeviceList';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';

const batch = 25;
const AtlasM365Panel = lazy(() => import('./AtlasM365Panel').then(module => ({ default: module.AtlasM365Panel })));

export function CustomerTechnicalDetails({ customerId, summary, contextChecking, onSourceInvalidated, onAccessDenied }: {
  customerId: string; summary: WorkspaceSummary | null; contextChecking: boolean;
  onSourceInvalidated: () => void; onAccessDenied: () => void;
}) {
  const { t } = useTranslation();
  const styles = useTechnicalStyles();
  const [active, setActive] = useState('observations');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceList, setDeviceList] = useState({ search: '', limit: deviceBatch });
  const [returnDevice, setReturnDevice] = useState<string | null>(null);
  const deviceFocused = useCallback(() => setReturnDevice(null), []);
  const queueTab = useRef<HTMLButtonElement>(null);
  const queueFocusRequested = useRef(false);
  useLayoutEffect(() => {
    if (active !== 'queue' || !queueFocusRequested.current) return;
    queueFocusRequested.current = false;
    queueTab.current?.focus({ preventScroll: true });
    queueTab.current?.scrollIntoView({ block: 'start' });
  }, [active]);
  const openQueue = (id: string | null) => {
    queueFocusRequested.current = true; setDeviceId(id); setActive('queue');
  };
  const id = useId();
  // On a narrow card the row scrolls; the edge that hides a tab fades.
  const tabRow = useRef<HTMLDivElement>(null);
  const tabEdges = useScrollEdges(tabRow, 'x', summary ? 'ready' : 'waiting');
  return <>
    <TabList ref={tabRow} style={tabEdges.style} className={styles.tabs} aria-label={t('parasolDetails.lists')} selectedValue={active} onTabSelect={(_, d) => setActive(String(d.value))}>
      <Tab disabled={!summary} id={`${id}-observations-tab`} aria-controls={`${id}-observations`} value="observations">{t('parasolDetails.observations')}</Tab>
      <Tab disabled={!summary} id={`${id}-devices-tab`} aria-controls={`${id}-devices`} value="devices">{t('parasolDetails.devices')}</Tab>
      <Tab disabled={!summary} ref={queueTab} id={`${id}-queue-tab`} aria-controls={`${id}-queue`} value="queue">{t('parasolQueue.title')}</Tab>
      <Tab id={`${id}-m365-tab`} aria-controls={`${id}-m365`} value="m365">{t('parasolM365.title')}</Tab>
    </TabList>
    <div role="tabpanel" id={`${id}-${active}`} aria-labelledby={`${id}-${active}-tab`}>
      {active === 'm365' ? <Suspense fallback={<Spinner size="small" label={t('common.loading')} />}>
        <AtlasM365Panel customerId={customerId} contextChecking={contextChecking} onSourceInvalidated={onSourceInvalidated} onAccessDenied={onAccessDenied} />
      </Suspense> : !summary ? <Spinner size="small" label={t('common.loading')} />
        : active === 'queue' ? <ObservationQueue customerId={customerId} onSourceInvalidated={onSourceInvalidated} deviceId={deviceId}
          onClearDevice={() => setDeviceId(null)} onReturnToDevice={() => { setReturnDevice(deviceId); setActive('devices'); }} />
        : active === 'devices' ? <AtlasDeviceList devices={summary.devices} selection={deviceList} onSelectionChange={setDeviceList}
          focusDeviceId={returnDevice} onFocused={deviceFocused} onOpenObservations={openQueue} />
        : <ObservationList customerId={customerId} onSourceInvalidated={onSourceInvalidated} summary={summary} openQueue={() => openQueue(null)} />}
    </div>
  </>;
}

function ObservationList({ summary, openQueue, customerId, onSourceInvalidated }: {
  summary: WorkspaceSummary; openQueue: () => void; customerId: string; onSourceInvalidated: () => void;
}) {
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
    <h3 className={mergeClasses(styles.heading, styles.display)} id={heading}>{t('parasolDetails.observations')}</h3>
    <Text block className={styles.note}>{t('parasolDetails.observationNote')}</Text>
    {page.truncated && <MessageBar layout="multiline" intent="warning"><MessageBarBody>
      {t('parasolDetails.partialObservations', { loaded: page.items.length, total: summary.activeObservations })}
    </MessageBarBody><MessageBarActions><Button size="small" onClick={openQueue}>{t('parasolQueue.open')}</Button></MessageBarActions></MessageBar>}
    {page.items.length === 0 ? <Text block role="status" className={styles.status}>{t('parasolDetails.noObservations')}</Text> : <>
      <div className={styles.toolbar}>
        <Field label={{ children: t('parasolDetails.searchObservations'), className: styles.hiddenLabel }}><Input type="search" value={search} maxLength={300}
          contentBefore={<Search16Regular />} placeholder={t('parasolDetails.searchObservations')}
          onChange={(_, d) => { setSearch(d.value); setLimit(batch); }} /></Field>
        <Field label={{ children: t('parasolDetails.severityFilter'), className: styles.hiddenLabel }}><Select value={severity} onChange={(_, d) => { setSeverity(d.value); setLimit(batch); }}>
          <option value="ALL">{t('parasolDetails.allSeverities')}</option>
          <option value="URGENT">{t('parasolDetails.urgent')}</option>
          {[...severities].reverse().map(s => <option key={s} value={s}>{t(`parasolDetails.severity.${s}`)}</option>)}
        </Select></Field>
        <Field label={{ children: t('parasolDetails.statusFilter'), className: styles.hiddenLabel }}><Select value={status} onChange={(_, d) => { setStatus(d.value); setLimit(batch); }}>
          <option value="ALL">{t('parasolDetails.allStatuses')}</option>
          <option value="OPEN">{t('parasolDetails.status.OPEN')}</option>
          <option value="ACKNOWLEDGED">{t('parasolDetails.status.ACKNOWLEDGED')}</option>
        </Select></Field>
      </div>
      <Text block role="status" className={styles.status}>{t('parasolDetails.observationMatches', { matched: matches.length, loaded: page.items.length })}</Text>
      {matches.length === 0 && <Text block className={styles.status}>{t('parasolDetails.noMatches')}</Text>}
      <ObservationRows key={`${severity}:${status}:${term}`} items={matches.slice(0, limit)} devices={summary.devices}
        customerId={customerId} onSourceInvalidated={onSourceInvalidated} scrollLabel={t('parasolDetails.observations')} />
      <div className={styles.footer}>
        <Text className={styles.status}>{t('parasolDetails.visible', { shown: Math.min(limit, matches.length), total: matches.length })}</Text>
        {matches.length > limit && <Button onClick={() => setLimit(n => n + batch)}>{t('parasolDetails.moreObservations')}</Button>}
      </div>
    </>}
  </section>;
}
