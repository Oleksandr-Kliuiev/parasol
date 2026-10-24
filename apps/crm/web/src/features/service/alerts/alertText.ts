import type { TFunction } from 'i18next';
import { formatDate } from '../../../shared/utils/format';
import type { Alert } from '../types';

/** The vendor named as the alert's source ("Source: Atera"); a system without a name of its own is shown as stored. */
export function sourceName(t: TFunction, system: string): string {
  return t(`alerts.sourceNames.${system}`, { defaultValue: system });
}

/** Parasoll's own coverage rules (M40) by their codes, with the words of each gap they find. */
const gapTitles: Record<string, (t: TFunction, facts: Record<string, string>) => string | null> = {
  'atera.agent-silent': (t, facts) => facts.device && facts.lastSeenAt
    ? t('alerts.gaps.ateraAgentSilent.title', { device: facts.device, date: formatDate(facts.lastSeenAt) })
    : null,
};

/** The key of a rule's words (`alerts.gaps.{key}`); none for a rule this interface does not know. */
export const gapKey = (rule: string | null | undefined) => rule === 'atera.agent-silent' ? 'ateraAgentSilent' : null;

/**
 * An alert's title in the reader's language: a gap Parasoll found (M40) is worded from its rule and facts; any other alert, and a
 * gap of a rule this interface does not know, keeps the title as stored.
 */
export function alertTitle(t: TFunction, alert: Pick<Alert, 'title' | 'rule' | 'facts'>): string {
  const word = alert.rule ? gapTitles[alert.rule] : undefined;
  return (word && alert.facts && word(t, alert.facts)) || alert.title;
}
