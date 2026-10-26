import type { TFunction } from 'i18next';
import { formatDate } from '../../../shared/utils/format';
import type { Alert } from '../types';

/** The vendor named as the alert's source ("Source: Atera"); a system without a name of its own is shown as stored. */
export function sourceName(t: TFunction, system: string): string {
  return t(`alerts.sourceNames.${system}`, { defaultValue: system });
}

/** Defender's status as Huntress words it, in the reader's language; a word the interface does not know is shown as Huntress wrote it. */
export const defenderStatus = (t: TFunction, status: string) => t(`machines.protection.defenderStatuses.${status}`, { defaultValue: status });

/** A backup gap's service in the reader's words (M42: "E-post", "OneDrive"). */
const service = (t: TFunction, facts: Record<string, string>) => t(`backup.services.${facts.service}`, { defaultValue: facts.service });

type GapWords = (t: TFunction, facts: Record<string, string>) => string | null;

/** Parasoll's own coverage rules (M40, M41, M42) by their codes: the key of their words, and the words of each gap they find. */
const gapRules: Record<string, { key: string; title: GapWords }> = {
  'atera.agent-silent': {
    key: 'ateraAgentSilent',
    title: (t, facts) => facts.device && facts.lastSeenAt
      ? t('alerts.gaps.ateraAgentSilent.title', { device: facts.device, date: formatDate(facts.lastSeenAt) })
      : null,
  },
  'huntress.agent-missing': {
    key: 'huntressAgentMissing',
    title: (t, facts) => facts.device && facts.since
      ? t('alerts.gaps.huntressAgentMissing.title', { device: facts.device, date: formatDate(facts.since) })
      : null,
  },
  'atera.agent-missing': {
    key: 'ateraAgentMissing',
    title: (t, facts) => facts.device && facts.since
      ? t('alerts.gaps.ateraAgentMissing.title', { device: facts.device, date: formatDate(facts.since) })
      : null,
  },
  'huntress.agent-silent': {
    key: 'huntressAgentSilent',
    title: (t, facts) => facts.device && facts.lastSeenAt
      ? t('alerts.gaps.huntressAgentSilent.title', { device: facts.device, date: formatDate(facts.lastSeenAt) })
      : null,
  },
  'huntress.agent-outdated': {
    key: 'huntressAgentOutdated',
    title: (t, facts) => facts.device && facts.version && facts.newest && facts.since
      ? t('alerts.gaps.huntressAgentOutdated.title', { device: facts.device, version: facts.version, newest: facts.newest, date: formatDate(facts.since) })
      : null,
  },
  'huntress.defender-off': {
    key: 'defenderOff',
    title: (t, facts) => facts.device && facts.status
      ? t('alerts.gaps.defenderOff.title', { device: facts.device, status: defenderStatus(t, facts.status) })
      : null,
  },
  'cloudally.backup-failed': {
    key: 'backupFailed',
    title: (t, facts) => facts.service && facts.failed && facts.total
      ? t('alerts.gaps.backupFailed.title', { service: service(t, facts), failed: facts.failed, total: facts.total, account: facts.account })
      : null,
  },
  'cloudally.backup-late': {
    key: 'backupLate',
    title: (t, facts) => facts.service && facts.late && facts.total && facts.hours
      ? t('alerts.gaps.backupLate.title', { service: service(t, facts), late: facts.late, total: facts.total, hours: facts.hours, account: facts.account })
      : null,
  },
  'cloudally.backup-paused': {
    key: 'backupPaused',
    title: (t, facts) => !facts.service ? null : facts.whole === 'true'
      ? t('alerts.gaps.backupPaused.whole', { service: service(t, facts), account: facts.account })
      : t('alerts.gaps.backupPaused.some', { service: service(t, facts), paused: facts.paused, total: facts.total, account: facts.account }),
  },
  'cloudally.user-not-backed-up': {
    key: 'userNotBackedUp',
    title: (t, facts) => facts.missing && facts.licensed && facts.backedUp
      ? t('alerts.gaps.userNotBackedUp.title', { count: Number(facts.missing), licensed: facts.licensed, backedUp: facts.backedUp })
      : null,
  },
};

/** The key of a rule's words (`alerts.gaps.{key}`, `coverage.rules.{key}`); none for a rule this interface does not know. */
export const gapKey = (rule: string | null | undefined) => (rule ? gapRules[rule]?.key ?? null : null);

/** A gap about backups (M42) leads to the customer's Sikkerhetskopi tab, where the users and the actions are. */
export const isBackupGap = (rule: string | null | undefined) => rule?.startsWith('cloudally.') === true;

/**
 * An alert's title in the reader's language: a gap Parasoll found (M40) is worded from its rule and facts; any other alert, and a
 * gap of a rule this interface does not know, keeps the title as stored.
 */
export function alertTitle(t: TFunction, alert: Pick<Alert, 'title' | 'rule' | 'facts'>): string {
  const word = alert.rule ? gapRules[alert.rule]?.title : undefined;
  return (word && alert.facts && word(t, alert.facts)) || alert.title;
}
