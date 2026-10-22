import { useState } from 'react';
import {
  Button, Checkbox, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Radio, RadioGroup, Text, makeStyles,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Dialog } from '../../shared/components/Dialog';
import { formatDateTime } from '../../shared/utils/format';
import { dayIn } from '../service/alerts/alertHiding';
import { entityRequest, type RestoreKind } from './backupActions';
import { entityName, serviceName } from './backupText';
import type { ActionRequest } from '../actions/types';
import type { BackupEntity } from './types';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '14px', gridTemplateColumns: 'minmax(0, 1fr)' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  // Each way says what it does under its label, as its own line of text tied to the radio by aria-describedby.
  way: { display: 'grid', gap: '2px', marginBottom: '6px' },
  wayNote: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', marginLeft: '32px' },
});

/** A plausible address: one @, a dot after it, no spaces. The server checks the domain; this only keeps a typo from going on. */
const looksLikeAddress = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** The domain of an address, lower case; empty for anything else. */
const domainOf = (value: string) => value.includes('@') ? value.slice(value.lastIndexOf('@') + 1).trim().toLowerCase() : '';

/**
 * The restore wizard (M42): one mailbox, OneDrive or site as it was at the end of a day — exported (PST for mail, ZIP for files),
 * restored into another account of the same domain (a new site for SharePoint), or restored in place. CloudAlly's API restores
 * whole entities only, which the dialog says, and only the ways switched on are offered. "Continue" hands the request to the
 * action confirmation, which shows CloudAlly's preview and asks what the way's level asks.
 */
export function RestoreDialog({ entity, kinds, onClose, onContinue }: {
  entity: BackupEntity; kinds: readonly RestoreKind[]; onClose: () => void;
  onContinue: (request: ActionRequest) => void;
}) {
  const { t } = useTranslation(); const styles = useStyles();
  const [kind, setKind] = useState<RestoreKind>(kinds[0] ?? 'restore.export');
  const [day, setDay] = useState(() => dayIn(0));
  const [target, setTarget] = useState('');
  const [deleted, setDeleted] = useState(false);
  const [touched, setTouched] = useState(false);
  const site = entity.service === 'SharePoint';
  const needsTarget = kind === 'restore.other' && !site;
  const dayOk = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= dayIn(0);
  const sameDomain = domainOf(target) !== '' && domainOf(target) === domainOf(entity.name);
  const targetOk = !needsTarget || (looksLikeAddress(target) && sameDomain && target.trim().toLowerCase() !== entity.name.toLowerCase());
  const targetMessage = !touched || targetOk ? undefined
    : !looksLikeAddress(target) ? t('backup.restore.targetInvalid')
      : target.trim().toLowerCase() === entity.name.toLowerCase() ? t('backup.restore.targetSame')
        : t('backup.restore.targetDomain', { domain: domainOf(entity.name) });
  const go = () => {
    setTouched(true);
    if (!dayOk || !targetOk) return;
    onContinue(entityRequest(entity, kind, {
      date: day, includeDeleted: deleted, ...(needsTarget ? { target: target.trim() } : {}),
    }));
  };
  const way = (value: RestoreKind) => {
    const key = value === 'restore.export' ? (entity.service === 'Mail' ? 'exportPst' : 'exportZip')
      : value === 'restore.other' ? (site ? 'newSite' : 'other') : 'inPlace';
    const note = `restore-${value}-note`;
    return <div key={value} className={styles.way}>
      <Radio value={value} label={t(`backup.restore.ways.${key}.label`)} input={{ 'aria-describedby': note }} />
      <Text id={note} className={styles.wayNote}>{t(`backup.restore.ways.${key}.note`)}</Text>
    </div>;
  };

  return <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
    <DialogSurface><DialogBody>
      <DialogTitle>{t('backup.restore.title', { name: entityName(entity) })}</DialogTitle>
      <DialogContent className={styles.content}>
        <Text block className={styles.muted}>
          {t('backup.restore.what', { service: serviceName(t, entity.service) })}{' '}
          {entity.lastBackupAt ? t('backup.restore.lastBackup', { time: formatDateTime(entity.lastBackupAt) }) : ''}
        </Text>
        <Field required label={t('backup.restore.day')} hint={t('backup.restore.dayHint')}
          validationMessage={touched && !dayOk ? t('backup.restore.dayInvalid') : undefined}>
          <Input type="date" value={day} max={dayIn(0)} onChange={(_, d) => setDay(d.value)} />
        </Field>
        <Field label={t('backup.restore.where')}>
          <RadioGroup value={kind} onChange={(_, d) => setKind(d.value as RestoreKind)}>
            {kinds.map(way)}
          </RadioGroup>
        </Field>
        {needsTarget && <Field required label={t('backup.restore.target')} hint={t('backup.restore.targetHint', { domain: domainOf(entity.name) })}
          validationMessage={targetMessage}>
          <Input type="email" value={target} autoComplete="off" onChange={(_, d) => setTarget(d.value)} />
        </Field>}
        <Checkbox checked={deleted} onChange={(_, d) => setDeleted(d.checked === true)} label={t('backup.restore.includeDeleted')} />
        <Text block className={styles.muted}>{t('backup.restore.wholeOnly')}</Text>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button appearance="primary" onClick={go}>{t('backup.restore.continue')}</Button>
      </DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}
