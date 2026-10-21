import type { TFunction } from 'i18next';
import { ApiError } from '../../api/client';
import { errorMessage } from '../../shared/utils/errors';
import type { ActionBlock, ActionEffect, VendorAction } from './types';

/** The kind as people say it ("Reply to the customer"); a kind the interface does not know yet keeps its code. */
export const kindName = (t: TFunction, system: string, kind: string) => t(`actions.kinds.${system}.${kind}`, { defaultValue: kind });

export const effectText = (t: TFunction, effect: ActionEffect) =>
  t(`actions.effects.${effect.code}`, { ...effect.values, defaultValue: effect.code, interpolation: { escapeValue: false } });

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
