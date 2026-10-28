import { useCallback, useState } from 'react';
import { api, query } from '../../../api/client';
import type { Alert, AlertSeverity, AlertState } from '../types';
import { queueParams, type AlertQueueFilters } from './useAlertQueue';

/** An alert as a bulk action takes it (M45): what names it in a confirmation and the ETag of its status in Parasoll as read now. */
export interface AlertSelectionItem {
  id: string;
  system: string;
  externalId: string;
  title: string;
  deviceName: string | null;
  organizationId: string;
  organizationName: string | null;
  severity: AlertSeverity;
  state: AlertState;
  /** When its source raised it, as the list's age says. */
  createdAt: string;
  /** Hidden in Parasoll until then; null when it is not hidden now. */
  hiddenUntil: string | null;
  rule: string | null;
  facts: Record<string, string> | null;
  sourceClosedAt: string | null;
  etag: string;
}

/** At most `limit` of the `totalCount` alerts that match, in the queue's order. */
export interface AlertSelectionPage {
  items: AlertSelectionItem[];
  totalCount: number;
  limit: number;
}

/** What a bulk hide or show did to one alert. */
export type AlertBulkOutcome = 'Hidden' | 'Shown' | 'Resolved' | 'NotHidden' | 'Changed' | 'NotFound';

export interface AlertBulkResult {
  /** A changed alert carries the ETag of its status after the change. */
  items: Array<{ id: string; outcome: AlertBulkOutcome; etag?: string | null }>;
  applied: number;
}

/**
 * Alerts a bulk hide hid, with the ETags of their status as the hide left it: the way back shows exactly those again, so an alert
 * someone decided about since (hidden for longer, shown, hidden again) comes back changed and stays as it is.
 */
export interface HiddenTogether {
  alerts: Array<{ id: string; etag: string }>;
  until: string;
}

/** What a hide answered, as the way back takes it; nothing when it hid none. */
export const hiddenTogether = (answer: AlertBulkResult, until: string): HiddenTogether | undefined => {
  const alerts = answer.items.flatMap((item) => item.outcome === 'Hidden' && item.etag ? [{ id: item.id, etag: item.etag }] : []);
  return alerts.length > 0 ? { alerts, until } : undefined;
};

/**
 * What a bulk action needs of a chosen alert, whether it was ticked in its row or came with "all that match": what names it in a
 * confirmation (its title or a gap's words, the customer, the device, how severe and how old) and its state.
 */
export interface ChosenAlert {
  id: string;
  system: string;
  externalId: string;
  title: string;
  rule: string | null;
  facts: Record<string, string> | null;
  organizationName: string | null;
  deviceName: string | null;
  severity: AlertSeverity;
  createdAt: string;
  state: AlertState;
  hidden: boolean;
}

const BASE = '/api/v1/service/alerts';

export const chosenFromAlert = (alert: Alert): ChosenAlert => ({
  id: alert.id, system: alert.system, externalId: alert.externalId, title: alert.title, rule: alert.rule ?? null, facts: alert.facts ?? null,
  organizationName: alert.organizationName, deviceName: alert.deviceName, severity: alert.severity, createdAt: alert.createdAt, state: alert.state,
  hidden: Boolean(alert.hidden),
});

export const chosenFromItem = (item: AlertSelectionItem): ChosenAlert => ({
  id: item.id, system: item.system, externalId: item.externalId, title: item.title, rule: item.rule, facts: item.facts,
  organizationName: item.organizationName, deviceName: item.deviceName, severity: item.severity, createdAt: item.createdAt, state: item.state,
  hidden: item.hiddenUntil !== null,
});

/** "All that match" the queue's filters (M45): at most the server's limit, in the queue's order, with how many matched. */
export async function selectMatching(filters: AlertQueueFilters) {
  return (await api.get<AlertSelectionPage>(`${BASE}/selection${query(queueParams(filters))}`)).data;
}

/** The chosen alerts as they are now: a bulk dialog reads them when it opens, and its change goes with the ETags of that read. */
export async function lookupAlerts(ids: readonly string[]) {
  return (await api.post<AlertSelectionPage>(`${BASE}/lookup`, { ids })).data;
}

/** Hides the alerts in Parasoll until the day (yyyy-mm-dd), with one reason for all of them; each answers what happened to it. */
export async function hideAlerts(alerts: ReadonlyArray<Pick<AlertSelectionItem, 'id' | 'etag'>>, until: string, reason: string) {
  return (await api.post<AlertBulkResult>(`${BASE}/hide`, { alerts: alerts.map(({ id, etag }) => ({ id, etag })), until, reason })).data;
}

/** Shows hidden alerts again: the way back from a bulk hide. */
export async function showAlerts(alerts: ReadonlyArray<Pick<AlertSelectionItem, 'id' | 'etag'>>) {
  return (await api.post<AlertBulkResult>(`${BASE}/show`, { alerts: alerts.map(({ id, etag }) => ({ id, etag })) })).data;
}

/** "All that match" while it is the selection: how many matched and how many one bulk action takes. */
export interface MatchingSelection {
  total: number;
  limit: number;
}

interface SelectionState {
  view: string;
  /** Moves with every change of the selection, so "all that match" asked before a change does not land over it. */
  version: number;
  chosen: ReadonlyMap<string, ChosenAlert>;
  matching: MatchingSelection | null;
}

const empty = (view: string, version: number): SelectionState => ({ view, version, chosen: new Map(), matching: null });

/**
 * The alerts a person chose in the queue (M45): rows ticked one by one or all at once, or "all that match" the filters. The selection
 * belongs to one view (state and filters): another view starts with none, as the time entries' selection does. Unticking a row of
 * "all that match" keeps the rest chosen, one by one. "All that match" is applied only over the selection it was asked from
 * (`version` when asked): a box ticked or Clear pressed while it is read wins.
 */
export function useAlertSelection(view: string) {
  const [state, setState] = useState<SelectionState>(() => empty(view, 0));
  const current = state.view === view ? state : empty(view, state.version);
  const change = useCallback((next: (chosen: Map<string, ChosenAlert>) => void) => setState((previous) => {
    const chosen = new Map(previous.view === view ? previous.chosen : []);
    next(chosen);
    return { view, version: previous.version + 1, chosen, matching: null };
  }), [view]);
  const toggle = useCallback((alert: Alert, on: boolean) => change((chosen) => {
    if (on) chosen.set(alert.id, chosenFromAlert(alert)); else chosen.delete(alert.id);
  }), [change]);
  const toggleAll = useCallback((alerts: readonly Alert[], on: boolean) => change((chosen) => {
    for (const alert of alerts) {
      if (on) chosen.set(alert.id, chosenFromAlert(alert)); else chosen.delete(alert.id);
    }
  }), [change]);
  const chooseMatching = useCallback((page: AlertSelectionPage, since: number) => setState((previous) => previous.version !== since ? previous : {
    view, version: since + 1, chosen: new Map(page.items.map((item) => [item.id, chosenFromItem(item)])),
    matching: { total: page.totalCount, limit: page.limit },
  }), [view]);
  const clear = useCallback(() => setState((previous) => empty(view, previous.version + 1)), [view]);
  return { chosen: current.chosen, matching: current.matching, version: current.version, toggle, toggleAll, chooseMatching, clear };
}

export type AlertSelection = ReturnType<typeof useAlertSelection>;

/** The chosen alerts a source action applies to: still open there, of that source. */
export const atSource = (chosen: Iterable<ChosenAlert>, system: string) => [...chosen].filter((a) => a.system === system && a.state !== 'Resolved');

/** The chosen alerts Parasoll can hide now: not resolved and not hidden already. */
export const hideable = (chosen: Iterable<ChosenAlert>) => [...chosen].filter((a) => a.state !== 'Resolved' && !a.hidden);

/** The chosen alerts hidden now, which can be shown again. */
export const showable = (chosen: Iterable<ChosenAlert>) => [...chosen].filter((a) => a.state !== 'Resolved' && a.hidden);
