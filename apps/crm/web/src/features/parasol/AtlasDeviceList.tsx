import { useEffect, useId, useRef } from 'react';
import { Button, Field, Input, Text, mergeClasses } from '@fluentui/react-components';
import { Desktop20Regular, Search16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import type { AtlasDevice } from './technicalContract';
import { TechnicalItem } from './TechnicalItem';
import { TechnicalList } from './TechnicalList';
import { useTechnicalStyles } from './technicalStyles';

export const deviceBatch = 25;
export type DeviceListSelection = { search: string; limit: number };

export function AtlasDeviceList({ devices, selection, onSelectionChange, onOpenObservations, focusDeviceId, onFocused }: {
  devices: AtlasDevice[]; selection: DeviceListSelection; onSelectionChange: (value: DeviceListSelection) => void;
  onOpenObservations: (deviceId: string) => void; focusDeviceId: string | null; onFocused: () => void;
}) {
  const { t } = useTranslation(); const styles = useTechnicalStyles(); const heading = useId();
  const actions = useRef(new Map<string, HTMLElement>());
  const { search, limit } = selection;
  const term = search.trim().toLocaleLowerCase();
  const matches = devices.filter(d => `${d.hostname} ${d.id}`.toLocaleLowerCase().includes(term));
  useEffect(() => {
    if (focusDeviceId === null) return;
    const action = actions.current.get(focusDeviceId);
    if (action) { action.focus({ preventScroll: true }); action.scrollIntoView({ block: 'center' }); }
    onFocused();
  }, [focusDeviceId, onFocused]);
  return <section className={styles.section} aria-labelledby={heading}>
    <h3 className={mergeClasses(styles.heading, styles.display)} id={heading}>{t('parasolDetails.devices')}</h3>
    <Text block className={styles.note}>{t('parasolDetails.deviceNote')}</Text>
    {devices.length === 0 ? <Text block role="status" className={styles.status}>{t('parasolDetails.noDevices')}</Text> : <>
      <div className={styles.toolbar}><Field className={styles.search} label={{ children: t('parasolDetails.searchDevices'), className: styles.hiddenLabel }}>
        <Input type="search" value={search} maxLength={256} contentBefore={<Search16Regular />} placeholder={t('parasolDetails.searchDevices')}
          onChange={(_, d) => onSelectionChange({ search: d.value, limit: deviceBatch })} />
      </Field></div>
      <Text block role="status" className={styles.status}>{t('parasolDetails.deviceMatches', { matched: matches.length, loaded: devices.length })}</Text>
      {matches.length === 0 && <Text block className={styles.status}>{t('parasolDetails.noMatches')}</Text>}
      <TechnicalList key={term} label={t('parasolDetails.devices')}>
        {matches.slice(0, limit).map(d => <li key={d.id} className={styles.row}>
          <TechnicalItem icon={<Desktop20Regular />} title={<code className={styles.identifier}>{d.hostname}</code>}
            meta={[
              <code key="id" className={styles.identifier}>{t('parasolDetails.deviceId')}: {d.id}</code>,
              <span key="sources">{d.sources.length ? t('parasolDetails.deviceSources', { sources: d.sources.map(s => t(`parasol.sources.${s}`)).join(', ') })
                : t('parasolDetails.noDeviceSources')}</span>,
            ]}
            action={<Button tabIndex={0} size="small" className={styles.deviceAction} aria-label={t('parasolDetails.deviceObservationsFor', { name: d.hostname })}
              ref={node => { if (node) actions.current.set(d.id, node); else actions.current.delete(d.id); }}
              onClick={() => onOpenObservations(d.id)}>{t('parasolDetails.deviceObservations')}</Button>} />
        </li>)}
      </TechnicalList>
      <div className={styles.footer}>
        <Text className={styles.status}>{t('parasolDetails.visible', { shown: Math.min(limit, matches.length), total: matches.length })}</Text>
        {matches.length > limit && <Button onClick={() => onSelectionChange({ search, limit: limit + deviceBatch })}>{t('parasolDetails.moreDevices')}</Button>}
      </div>
    </>}
  </section>;
}
