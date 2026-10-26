import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { MoreHorizontal20Regular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { formatDate, formatDateTime } from '../../../shared/utils/format';
import { ActionDialog } from '../../actions/ActionDialog';
import { ActionList } from '../../actions/ActionLog';
import type { VendorAction } from '../../actions/types';
import { confirmClosed } from '../../security/api';
import { AlertHideDialog } from './AlertHideDialog';
import { showAlert } from './alertHiding';
import {
  AlertActionsContext, alertRequest, useAlertActions, useAlertParasollKinds, useAlertSourceKinds, type AlertLike, type AlertParasollKind,
  type AlertSourceKind,
} from './alertSourceActions';
import { alertTitle, sourceName } from './alertText';

const useStyles = makeStyles({
  section: { display: 'grid', gap: '8px', minWidth: 0 },
  heading: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 700 },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  log: { marginLeft: '-20px', marginRight: '-20px', '@media (max-width: 600px)': { marginLeft: '-16px', marginRight: '-16px' } },
});

/** Reads the alerts again everywhere they are shown once a change at the source or in Parasoll went through. */
function useAlertsChanged() {
  const client = useQueryClient();
  return useCallback(() => void client.invalidateQueries({ queryKey: ['service', 'alerts'] }), [client]);
}

/** Shows a hidden alert again at once (it is reversible), and says so; true when it went through. */
function useShowAgain() {
  const { t } = useTranslation(); const notify = useNotify(); const changed = useAlertsChanged();
  return useCallback(async (alert: AlertLike) => {
    try {
      await showAlert(alert);
      changed();
      notify(t('alerts.hide.shown'));
      return true;
    } catch (failure) {
      notify(errorMessage(failure, t), 'error');
      return false;
    }
  }, [changed, notify, t]);
}

/** Confirms the closing of an urgent alert its source closed (M41), at once, and says so; true when it went through. */
function useConfirmClosed() {
  const { t } = useTranslation(); const notify = useNotify(); const changed = useAlertsChanged();
  return useCallback(async (alert: AlertLike) => {
    try {
      await confirmClosed(alert);
      changed();
      notify(t('alerts.closedAtSource.confirmed'));
      return true;
    } catch (failure) {
      notify(errorMessage(failure, t), 'error');
      return false;
    }
  }, [changed, notify, t]);
}

/**
 * A hidden or shown alert leaves the list it was in, with the button that changed it: focus goes to the list (data-alert-list),
 * never to the page behind it.
 */
const focusList = () => window.setTimeout(() => document.querySelector<HTMLElement>('[data-alert-list]')?.focus(), 0);

/**
 * Holds the confirmation of an alert action and the hide dialog outside the rows of a list, as AlertTaskDialogHost does for the
 * assign dialog: a row is drawn again when the list reloads, and a dialog inside it would vanish while it is in use.
 */
export function AlertActionsHost({ children }: { children: ReactNode }) {
  const { t } = useTranslation(); const changed = useAlertsChanged(); const showAgain = useShowAgain(); const confirm = useConfirmClosed();
  const [asked, setAsked] = useState<{ alert: AlertLike; kind: AlertSourceKind } | null>(null);
  const [hiding, setHiding] = useState<string | null>(null);
  const ask = useCallback((alert: AlertLike, kind: AlertSourceKind | AlertParasollKind) => {
    if (kind === 'hide') setHiding(alert.id);
    else if (kind === 'show') void showAgain(alert).then((shown) => { if (shown) focusList(); });
    else if (kind === 'confirm') void confirm(alert).then((done) => { if (done) focusList(); });
    else setAsked({ alert, kind });
  }, [confirm, showAgain]);
  const value = useMemo(() => ({ ask }), [ask]);
  const finished = (action: VendorAction) => { if (action.status === 'Succeeded' || action.status === 'Skipped') changed(); };
  return <AlertActionsContext.Provider value={value}>
    {children}
    <ActionDialog request={asked ? alertRequest(asked.alert, asked.kind) : null}
      title={asked ? t(asked.kind === 'alert.delete' ? 'alerts.actions.deleteTitle' : 'alerts.actions.resolveTitle') : ''}
      confirm={asked ? t(asked.kind === 'alert.delete' ? 'alerts.actions.delete' : 'alerts.actions.resolve') : ''}
      onClose={() => setAsked(null)} onFinished={finished} />
    {hiding && <AlertHideDialog alertId={hiding} onClose={() => setHiding(null)} onHidden={focusList} />}
  </AlertActionsContext.Provider>;
}

/** Puts focus on a section's heading once the change that removed the button which had it is drawn. */
const focusHeading = (heading: RefObject<HTMLHeadingElement | null>) => window.setTimeout(() => heading.current?.focus(), 0);

/**
 * The alert's own panel (M40): whether it is hidden in Parasoll and the way to hide it or show it again, then what can be done with
 * it at its source and the actions already asked for it. The panel stays open while the list behind it reloads, and keeps what it
 * shows while the alert is read again, so it holds its dialogs itself. A change swaps or removes the button that made it: focus
 * then goes to the heading of the section that says what is now true.
 */
export function AlertSourceSection({ alert }: { alert: AlertLike }) {
  const { t } = useTranslation(); const styles = useStyles(); const restore = useRestoreFocusTarget();
  const changed = useAlertsChanged(); const showAgain = useShowAgain(); const confirm = useConfirmClosed();
  const kinds = useAlertSourceKinds(alert); const own = useAlertParasollKinds(alert);
  const [kind, setKind] = useState<AlertSourceKind | null>(null);
  const [hiding, setHiding] = useState(false); const [confirming, setConfirming] = useState(false);
  const ownHeading = useRef<HTMLHeadingElement>(null); const sourceHeading = useRef<HTMLHeadingElement>(null);
  const done = useRef(false);
  const source = sourceName(t, alert.system);
  const finished = (action: VendorAction) => { if (action.status === 'Succeeded' || action.status === 'Skipped') { done.current = true; changed(); } };
  return <>
    {(alert.hidden || own.length > 0 || alert.sourceClosedAt) && <section className={styles.section} aria-labelledby={`alert-own-${alert.id}`}>
      <h3 id={`alert-own-${alert.id}`} ref={ownHeading} tabIndex={-1} className={styles.heading}>{t('alerts.hide.heading')}</h3>
      {/* M41: an urgent alert its source closed stays open here until a person confirms the closing. */}
      {alert.sourceClosedAt && alert.state !== 'Resolved' && <Text block>
        {t('alerts.closedAtSource.explain', { source, date: formatDateTime(alert.sourceClosedAt) })}</Text>}
      {alert.hidden
        ? <Text block>{t('alerts.hide.hiddenSince', {
          date: formatDate(alert.hidden.until), name: alert.hidden.byName ?? t('alerts.hide.someone'), reason: alert.hidden.reason ?? '',
        })}</Text>
        : alert.rule ? <Text block className={styles.muted}>{t('alerts.hide.gapStays')}</Text>
          // What hiding does is said only where hiding is offered, and never of an alert its source has closed.
          : own.includes('hide') && !alert.sourceClosedAt && <Text block className={styles.muted}>{t('alerts.hide.sourceStays', { source })}</Text>}
      {own.length > 0 && <span className={styles.buttons}>
        {/* Confirmed, the alert is resolved and this section goes: focus moves to the source's section, which stays. */}
        {own.includes('confirm') && <Button size="small" disabled={confirming} disabledFocusable={confirming} onClick={() => {
          setConfirming(true);
          void confirm(alert).then((done) => { setConfirming(false); if (done) focusHeading(sourceHeading); });
        }}>{t('alerts.closedAtSource.confirm')}</Button>}
        {own.includes('hide') && <Button {...restore} size="small" onClick={() => setHiding(true)}>{t('alerts.hide.open')}</Button>}
        {own.includes('show') && <Button size="small" onClick={() => void showAgain(alert).then((shown) => { if (shown) focusHeading(ownHeading); })}>
          {t('alerts.hide.show')}</Button>}
      </span>}
    </section>}
    {/* A gap Parasoll found (M40) has no source to act at: what there is to do with it is above. */}
    {!alert.rule && <section className={styles.section} aria-labelledby={`alert-source-${alert.id}`}>
      <h3 id={`alert-source-${alert.id}`} ref={sourceHeading} tabIndex={-1} className={styles.heading}>{t('alerts.actions.heading', { source })}</h3>
      {kinds.length > 0 && <span className={styles.buttons}>
        {kinds.includes('alert.resolve') && <Button {...restore} size="small" onClick={() => setKind('alert.resolve')}>{t('alerts.actions.resolve')}</Button>}
        {kinds.includes('alert.delete') && <Button {...restore} size="small" appearance="subtle" onClick={() => setKind('alert.delete')}>{t('alerts.actions.deleteItem')}</Button>}
      </span>}
      <div className={styles.log}>
        <ActionList filters={{ targetType: 'alert', targetId: alert.externalId }} showTarget={false} limit={5} empty={t('alerts.actions.none', { source })} />
      </div>
    </section>}
    <ActionDialog request={kind ? alertRequest(alert, kind) : null}
      title={kind ? t(kind === 'alert.delete' ? 'alerts.actions.deleteTitle' : 'alerts.actions.resolveTitle') : ''}
      confirm={kind ? t(kind === 'alert.delete' ? 'alerts.actions.delete' : 'alerts.actions.resolve') : ''}
      onClose={() => { setKind(null); if (done.current) { done.current = false; focusHeading(sourceHeading); } }} onFinished={finished} />
    {hiding && <AlertHideDialog alertId={alert.id} onClose={() => setHiding(false)} onHidden={() => focusHeading(ownHeading)} />}
  </>;
}

/** A row's menu of what can be done with its alert, in Parasoll and at the source; nothing when nothing can. */
export function AlertActionsMenu({ alert }: { alert: AlertLike }) {
  const { t } = useTranslation(); const restore = useRestoreFocusTarget();
  const { ask } = useAlertActions();
  const kinds = useAlertSourceKinds(alert); const own = useAlertParasollKinds(alert);
  if (kinds.length === 0 && own.length === 0) return null;
  return <Menu positioning="below-end">
    <MenuTrigger disableButtonEnhancement>
      <Button {...restore} size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={t('alerts.actions.menu', { title: alertTitle(t, alert) })} />
    </MenuTrigger>
    <MenuPopover><MenuList>
      {own.includes('confirm') && <MenuItem onClick={() => ask(alert, 'confirm')}>{t('alerts.closedAtSource.confirm')}</MenuItem>}
      {own.includes('hide') && <MenuItem onClick={() => ask(alert, 'hide')}>{t('alerts.hide.open')}</MenuItem>}
      {own.includes('show') && <MenuItem onClick={() => ask(alert, 'show')}>{t('alerts.hide.show')}</MenuItem>}
      {kinds.includes('alert.resolve') && <MenuItem onClick={() => ask(alert, 'alert.resolve')}>{t('alerts.actions.resolve')}</MenuItem>}
      {kinds.includes('alert.delete') && <MenuItem onClick={() => ask(alert, 'alert.delete')}>{t('alerts.actions.deleteItem')}</MenuItem>}
    </MenuList></MenuPopover>
  </Menu>;
}
