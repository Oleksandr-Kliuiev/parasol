import type { TFunction } from 'i18next';
import { formatDate } from '../../../shared/utils/format';
import type { Alert } from '../types';

/** The vendor named as the alert's source ("Source: Atera"); a system without a name of its own is shown as stored. */
export function sourceName(t: TFunction, system: string): string {
  return t(`alerts.sourceNames.${system}`, { defaultValue: system });
}

/** Defender's status as Huntress words it, in the reader's language; a word the interface does not know is shown as Huntress wrote it. */
export const defenderStatus = (t: TFunction, status: string) => t(`machines.protection.defenderStatuses.${status}`, { defaultValue: status });

type GapWords = (t: TFunction, facts: Record<string, string>) => string | null;

/** Parasoll's own coverage rules (M40, M41) by their codes: the key of their words, and the words of each gap they find. */
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
};

/** The key of a rule's words (`alerts.gaps.{key}`, `coverage.rules.{key}`); none for a rule this interface does not know. */
export const gapKey = (rule: string | null | undefined) => (rule ? gapRules[rule]?.key ?? null : null);

/**
 * An alert's title in the reader's language: a gap Parasoll found (M40) is worded from its rule and facts; any other alert, and a
 * gap of a rule this interface does not know, keeps the title as stored.
 */
export function alertTitle(t: TFunction, alert: Pick<Alert, 'title' | 'rule' | 'facts'>): string {
  const word = alert.rule ? gapRules[alert.rule]?.title : undefined;
  return (word && alert.facts && word(t, alert.facts)) || alert.title;
}
