import type { TFunction } from 'i18next';
import { ApiError } from '../../api/client';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate } from '../../shared/utils/format';
import type { ActionBlock, ActionEffect, VendorAction } from './types';

/** The kind as people say it ("Reply to the customer"); a kind the interface does not know yet keeps its code. */
export const kindName = (t: TFunction, system: string, kind: string) => t(`actions.kinds.${system}.${kind}`, { defaultValue: kind });

/** Values that are Atera's own words (a status, a priority) or empty, said the way the rest of the interface says them. */
const effectValues = (t: TFunction, effect: ActionEffect): Record<string, string | null> => {
  const values = { ...effect.values };
  const word = (group: 'statuses' | 'priorities', value: string | null | undefined, empty: string) =>
    value ? t(`tickets.${group}.${value}`, { defaultValue: value }) : t(empty);
  switch (effect.code) {
    case 'VND_EFFECT_TICKET_STATUS':
      return { ...values, from: word('statuses', values.from, 'tickets.statuses.Open'), to: word('statuses', values.to, 'tickets.statuses.Open') };
    case 'VND_EFFECT_TICKET_REOPEN':
      return { ...values, status: word('statuses', values.status, 'tickets.statuses.Open') };
    case 'VND_EFFECT_TICKET_PRIORITY':
      return { ...values, from: word('priorities', values.from, 'tickets.fields.noPriority'), to: word('priorities', values.to, 'tickets.fields.noPriority') };
    case 'VND_EFFECT_TICKET_TECHNICIAN':
      return { ...values, from: values.from || t('tickets.fields.noTechnician') };
    default:
      // M42: a backup's service is CloudAlly's word for it ("Mail"), said the way the backup tab says it; a restore's day as days are.
      return {
        ...values,
        ...(values.service ? { service: t(`backup.services.${values.service}`, { defaultValue: values.service }) } : {}),
        ...(effect.code.startsWith('VND_EFFECT_RESTORE_') && values.date ? { date: formatDate(values.date) } : {}),
      };
  }
};

export const effectText = (t: TFunction, effect: ActionEffect) =>
  t(`actions.effects.${effect.code}`, { ...effectValues(t, effect), defaultValue: effect.code, interpolation: { escapeValue: false } });

/**
 * Every code of the action path — what blocks an action, why a command was refused, what the worker did — lives in one place
 * (`actions.codes`), because a switch that blocks a preview is also what a rejected action ends with. A code the interface does
 * not know yet shows the server's English.
 */
export const codeText = (t: TFunction, code: string, fallback: string) => t(`actions.codes.${code}`, { defaultValue: fallback });

/** Why an action cannot be asked for now, in the reader's language. */
export const blockText = (t: TFunction, block: ActionBlock) => codeText(t, block.code, block.message);

export const outcomeText = (t: TFunction, action: Pick<VendorAction, 'outcomeCode' | 'outcome'>) =>
  action.outcomeCode ? codeText(t, action.outcomeCode, action.outcome ?? '') : '';

/** A refused request of the action path in the reader's language; any other error as the whole interface says it. */
export const actionErrorText = (t: TFunction, error: unknown) =>
  error instanceof ApiError && error.code?.startsWith('VND_') ? codeText(t, error.code, error.message) : errorMessage(error, t);

/** The typed name matches the way the server compares it: case and runs of spaces do not count. */
export const nameMatches = (typed: string, name: string) =>
  typed.trim().split(/\s+/).join(' ').toLowerCase() === name.trim().split(/\s+/).join(' ').toLowerCase();
