import type { ReactElement } from 'react';
import { Badge, Button, Link, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import {
  ArrowCounterclockwise16Regular, ArrowSync16Regular, Cloud16Regular, CloudArchive16Regular, Globe16Regular, Mail16Regular, MoreHorizontal20Regular,
  Open16Regular, PeopleTeam16Regular, PersonAdd16Regular,
} from '@fluentui/react-icons';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { h, type Tone } from '../../app/hearth';
import { formatDateTime, formatRelative } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { RecordRow, RowMeta } from '../billing/RecordRow';
import { entityRequest, restorable, restoreKinds, taskRequest, useBackupActions } from './backupActions';
import { entityName, serviceName, stateColor, stateName } from './backupText';
import type { BackupEntity, BackupService, BackupState, BackupTask } from './types';

const useStyles = makeStyles({
  time: { fontVariantNumeric: 'tabular-nums' },
  error: { color: h.emberT },
  // The help page opens CloudAlly's site in a new tab: its mark stays beside the words, with a 24 px hit box (WCAG 2.5.8).
  help: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', '& svg': { flexShrink: 0 } },
  name: { overflowWrap: 'anywhere' },
});

const icons: Record<BackupService, ReactElement> = {
  Mail: <Mail16Regular />, OneDrive: <Cloud16Regular />, SharePoint: <Globe16Regular />, Teams: <PeopleTeam16Regular />, Other: <CloudArchive16Regular />,
};

const serviceIcon = (service: BackupService) => icons[service];

const tones: Record<BackupState, Tone> = { Failed: 'ember', Late: 'saffron', Paused: 'saffron', NotInBackup: 'saffron', Waiting: 'iris', Ok: 'spruce', Aside: 'neutral' };

/** "Last backup 3 hours ago", the exact time on hover; "never backed up" for an entity without one. */
export function LastBackup({ at, t }: { at: string | null; t: TFunction }) {
  const styles = useStyles();
  return at
    ? <>{t('backup.lastBackup')} <time className={styles.time} dateTime={at} title={formatDateTime(at)}>{formatRelative(at)}</time></>
    : <>{t('backup.neverBackedUp')}</>;
}

/**
 * One mailbox, OneDrive, site or team of the customer (M42): who or what it is, the service, its state, its last backup and, for a
 * failed one, CloudAlly's own words with its help page. The menu holds what can be done with it now: a backup now, adding it to the
 * backup, a restore.
 */
export function BackupEntityRow({ entity }: { entity: BackupEntity }) {
  const { t } = useTranslation(); const styles = useStyles(); const restore = useRestoreFocusTarget();
  const actions = useBackupActions();
  const run = actions.kinds.has('backup.run') && (entity.state === 'Ok' || entity.state === 'Failed' || entity.state === 'Late' || entity.state === 'Waiting');
  const add = actions.kinds.has('backup.activate') && entity.state === 'NotInBackup';
  const restores = restorable(entity.service) && entity.lastBackupAt !== null && entity.state !== 'NotInBackup'
    && restoreKinds.some((kind) => actions.kinds.has(kind));
  const help = entity.errorLink ? safeHttpUrl(entity.errorLink) : undefined;
  const name = entityName(entity);
  return <RecordRow icon={serviceIcon(entity.service)} tone={tones[entity.state]}
    title={<span className={styles.name}>{name}</span>}
    meta={<>
      <RowMeta>{serviceName(t, entity.service)} · <LastBackup at={entity.lastBackupAt} t={t} /></RowMeta>
      {entity.error && <RowMeta><Text className={styles.error} size={200}>{t('backup.error', { error: entity.error })}</Text>
        {help && <>{' · '}<Link href={help} target="_blank" rel="noopener noreferrer" className={styles.help}>
          {t('backup.errorHelp')}<Open16Regular aria-hidden /></Link></>}</RowMeta>}
    </>}
    end={<>
      {/* After "back up now" the read of the task says a backup runs; its result comes with the next read. */}
      {entity.running && <Badge appearance="tint" color="informative">{t('backup.running')}</Badge>}
      <Badge appearance="tint" color={stateColor(entity.state)}>{stateName(t, entity.state)}</Badge>
      {(run || add || restores) && <Menu positioning="below-end">
        <MenuTrigger disableButtonEnhancement>
          <Button {...restore} size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={t('backup.entityMenu', { name })} />
        </MenuTrigger>
        <MenuPopover><MenuList>
          {add && <MenuItem icon={<PersonAdd16Regular />} onClick={() => actions.ask(entityRequest(entity, 'backup.activate'))}>{t('backup.actions.backup.activate.item')}</MenuItem>}
          {run && <MenuItem icon={<ArrowSync16Regular />} onClick={() => actions.ask(entityRequest(entity, 'backup.run'))}>{t('backup.actions.backup.run.item')}</MenuItem>}
          {restores && <MenuItem icon={<ArrowCounterclockwise16Regular />} onClick={() => actions.restore(entity)}>{t('backup.restore.item')}</MenuItem>}
        </MenuList></MenuPopover>
      </Menu>}
    </>} />;
}

/**
 * One backup task: a service of one CloudAlly account, with its users or sites counted, its last backup and whether it is paused or
 * running. "Take a backup now" is the row's one button; pausing and resuming are in its menu.
 */
export function BackupTaskRow({ task, showAccount }: { task: BackupTask; showAccount: boolean }) {
  const { t } = useTranslation(); const restore = useRestoreFocusTarget();
  const actions = useBackupActions();
  const label = `${serviceName(t, task.service)}${showAccount ? ` · ${task.accountName}` : ''}`;
  const run = actions.kinds.has('backup.run') && !task.paused && !task.running;
  const pause = actions.kinds.has('backup.pause') && !task.paused;
  const resume = actions.kinds.has('backup.resume') && task.paused;
  return <RecordRow icon={serviceIcon(task.service)} tone={task.paused ? 'saffron' : task.problems > 0 ? 'ember' : 'spruce'}
    title={label}
    meta={<RowMeta>{[t('backup.taskEntities', { count: task.entities }), task.problems > 0 ? t('backup.taskProblems', { count: task.problems }) : null]
      .filter(Boolean).join(' · ')} · <LastBackup at={task.lastBackupAt} t={t} /></RowMeta>}
    end={<>
      {task.paused && <Badge appearance="tint" color="warning">{t('backup.states.Paused')}</Badge>}
      {task.running && <Badge appearance="tint" color="informative">{t('backup.running')}</Badge>}
      {/* Several tasks have the same button: the task is in its name, the visible words first (WCAG 2.5.3). */}
      {run && <Button {...restore} size="small" icon={<ArrowSync16Regular />} aria-label={t('backup.actions.backup.run.named', { name: label })}
        onClick={() => actions.ask(taskRequest(task, 'backup.run'))}>{t('backup.actions.backup.run.button')}</Button>}
      {resume && <Button {...restore} size="small" aria-label={t('backup.actions.backup.resume.named', { name: label })}
        onClick={() => actions.ask(taskRequest(task, 'backup.resume'))}>{t('backup.actions.backup.resume.item')}</Button>}
      {pause && <Menu positioning="below-end">
        <MenuTrigger disableButtonEnhancement>
          <Button {...restore} size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={t('backup.taskMenu', { name: label })} />
        </MenuTrigger>
        <MenuPopover><MenuList>
          <MenuItem onClick={() => actions.ask(taskRequest(task, 'backup.pause'))}>{t('backup.actions.backup.pause.item')}</MenuItem>
        </MenuList></MenuPopover>
      </Menu>}
    </>} />;
}
