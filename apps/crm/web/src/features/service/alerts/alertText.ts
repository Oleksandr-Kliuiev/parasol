import type { TFunction } from 'i18next';
import { formatDate } from '../../../shared/utils/format';
import type { Alert } from '../types';

/** The vendor named as the alert's source ("Source: Atera"); a system without a name of its own is shown as stored. */
export function sourceName(t: TFunction, system: string): string {
  return t(`alerts.sourceNames.${system}`, { defaultValue: system });
}

/** A backup gap's service in the reader's words (M42: "E-post", "OneDrive"). */
const service = (t: TFunction, facts: Record<string, string>) => t(`backup.services.${facts.service}`, { defaultValue: facts.service });

/** Parasoll's own coverage rules (M40, M42) by their codes, with the words of each gap they find. */
const gapTitles: Record<string, (t: TFunction, facts: Record<string, string>) => string | null> = {
  'atera.agent-silent': (t, facts) => facts.device && facts.lastSeenAt
    ? t('alerts.gaps.ateraAgentSilent.title', { device: facts.device, date: formatDate(facts.lastSeenAt) })
    : null,
  'cloudally.backup-failed': (t, facts) => facts.service && facts.failed && facts.total
    ? t('alerts.gaps.backupFailed.title', { service: service(t, facts), failed: facts.failed, total: facts.total, account: facts.account })
    : null,
  'cloudally.backup-late': (t, facts) => facts.service && facts.late && facts.total && facts.hours
    ? t('alerts.gaps.backupLate.title', { service: service(t, facts), late: facts.late, total: facts.total, hours: facts.hours, account: facts.account })
    : null,
  'cloudally.backup-paused': (t, facts) => !facts.service ? null : facts.whole === 'true'
    ? t('alerts.gaps.backupPaused.whole', { service: service(t, facts), account: facts.account })
    : t('alerts.gaps.backupPaused.some', { service: service(t, facts), paused: facts.paused, total: facts.total, account: facts.account }),
  'cloudally.user-not-backed-up': (t, facts) => facts.missing && facts.licensed && facts.backedUp
    ? t('alerts.gaps.userNotBackedUp.title', { count: Number(facts.missing), licensed: facts.licensed, backedUp: facts.backedUp })
    : null,
};

/** The keys of the rules' words (`alerts.gaps.{key}`, `coverage.rules.{key}`). */
const gapKeys: Record<string, string> = {
  'atera.agent-silent': 'ateraAgentSilent',
  'cloudally.backup-failed': 'backupFailed',
  'cloudally.backup-late': 'backupLate',
  'cloudally.backup-paused': 'backupPaused',
  'cloudally.user-not-backed-up': 'userNotBackedUp',
};

/** The key of a rule's words; none for a rule this interface does not know. */
export const gapKey = (rule: string | null | undefined) => (rule && gapKeys[rule]) || null;

/** A gap about backups (M42) leads to the customer's Sikkerhetskopi tab, where the users and the actions are. */
export const isBackupGap = (rule: string | null | undefined) => rule?.startsWith('cloudally.') === true;

/**
 * An alert's title in the reader's language: a gap Parasoll found (M40) is worded from its rule and facts; any other alert, and a
 * gap of a rule this interface does not know, keeps the title as stored.
 */
export function alertTitle(t: TFunction, alert: Pick<Alert, 'title' | 'rule' | 'facts'>): string {
  const word = alert.rule ? gapTitles[alert.rule] : undefined;
  return (word && alert.facts && word(t, alert.facts)) || alert.title;
}
