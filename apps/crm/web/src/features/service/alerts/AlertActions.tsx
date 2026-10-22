import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, Text, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { MoreHorizontal20Regular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { formatDate } from '../../../shared/utils/format';
import { ActionDialog } from '../../actions/ActionDialog';
import { ActionList } from '../../actions/ActionLog';
import type { VendorAction } from '../../actions/types';
import { AlertHideDialog } from './AlertHideDialog';
import { showAlert } from './alertHiding';
import {
  AlertActionsContext, alertRequest, useAlertActions, useAlertParasollKinds, useAlertSourceKinds, type AlertLike, type AlertParasollKind,
  type AlertSourceKind,
} from './alertSourceActions';
import { sourceName } from './alertText';

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
  const { t } = useTranslation(); const changed = useAlertsChanged(); const showAgain = useShowAgain();
  const [asked, setAsked] = useState<{ alert: AlertLike; kind: AlertSourceKind } | null>(null);
  const [hiding, setHiding] = useState<string | null>(null);
  const ask = useCallback((alert: AlertLike, kind: AlertSourceKind | AlertParasollKind) => {
    if (kind === 'hide') setHiding(alert.id);
    else if (kind === 'show') void showAgain(alert).then((shown) => { if (shown) focusList(); });
    else setAsked({ alert, kind });
  }, [showAgain]);
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

/**
 * The alert's own panel (M40): whether it is hidden in Parasoll and the way to hide it or show it again, then what can be done with
 * it at its source and the actions already asked for it. The panel stays open while the list behind it reloads, so it holds its
 * dialogs itself. Hiding or showing reads the alert again and the panel draws it anew: `onChanged` lets it put focus back on the
 * section that says what is now true (its heading's id is `alert-own-{id}`).
 */
export function AlertSourceSection({ alert, onChanged }: { alert: AlertLike; onChanged?: () => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const restore = useRestoreFocusTarget();
  const changed = useAlertsChanged(); const showAgain = useShowAgain();
  const kinds = useAlertSourceKinds(alert); const own = useAlertParasollKinds(alert);
  const [kind, setKind] = useState<AlertSourceKind | null>(null);
  const [hiding, setHiding] = useState(false);
  const source = sourceName(t, alert.system);
  const finished = (action: VendorAction) => { if (action.status === 'Succeeded' || action.status === 'Skipped') changed(); };
  return <>
    {(alert.hidden || own.length > 0) && <section className={styles.section} aria-labelledby={`alert-own-${alert.id}`}>
      <h3 id={`alert-own-${alert.id}`} tabIndex={-1} className={styles.heading}>{t('alerts.hide.heading')}</h3>
      {alert.hidden
        ? <Text block>{t('alerts.hide.hiddenSince', {
          date: formatDate(alert.hidden.until), name: alert.hidden.byName ?? t('alerts.hide.someone'), reason: alert.hidden.reason ?? '',
        })}</Text>
        : <Text block className={styles.muted}>{t('alerts.hide.sourceStays', { source })}</Text>}
      {own.length > 0 && <span className={styles.buttons}>
        {own.includes('hide') && <Button {...restore} size="small" onClick={() => setHiding(true)}>{t('alerts.hide.open')}</Button>}
        {own.includes('show') && <Button size="small" onClick={() => void showAgain(alert).then((shown) => { if (shown) onChanged?.(); })}>
          {t('alerts.hide.show')}</Button>}
      </span>}
    </section>}
    <section className={styles.section} aria-labelledby={`alert-source-${alert.id}`}>
      <h3 id={`alert-source-${alert.id}`} className={styles.heading}>{t('alerts.actions.heading', { source })}</h3>
      {kinds.length > 0 && <span className={styles.buttons}>
        {kinds.includes('alert.resolve') && <Button {...restore} size="small" onClick={() => setKind('alert.resolve')}>{t('alerts.actions.resolve')}</Button>}
        {kinds.includes('alert.delete') && <Button {...restore} size="small" appearance="subtle" onClick={() => setKind('alert.delete')}>{t('alerts.actions.deleteItem')}</Button>}
      </span>}
      <div className={styles.log}>
        <ActionList filters={{ targetType: 'alert', targetId: alert.externalId }} showTarget={false} limit={5} empty={t('alerts.actions.none')} />
      </div>
    </section>
    <ActionDialog request={kind ? alertRequest(alert, kind) : null}
      title={kind ? t(kind === 'alert.delete' ? 'alerts.actions.deleteTitle' : 'alerts.actions.resolveTitle') : ''}
      confirm={kind ? t(kind === 'alert.delete' ? 'alerts.actions.delete' : 'alerts.actions.resolve') : ''}
      onClose={() => setKind(null)} onFinished={finished} />
    {hiding && <AlertHideDialog alertId={alert.id} onClose={() => setHiding(false)} onHidden={onChanged} />}
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
      <Button {...restore} size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={t('alerts.actions.menu', { title: alert.title })} />
    </MenuTrigger>
    <MenuPopover><MenuList>
      {own.includes('hide') && <MenuItem onClick={() => ask(alert, 'hide')}>{t('alerts.hide.open')}</MenuItem>}
      {own.includes('show') && <MenuItem onClick={() => ask(alert, 'show')}>{t('alerts.hide.show')}</MenuItem>}
      {kinds.includes('alert.resolve') && <MenuItem onClick={() => ask(alert, 'alert.resolve')}>{t('alerts.actions.resolve')}</MenuItem>}
      {kinds.includes('alert.delete') && <MenuItem onClick={() => ask(alert, 'alert.delete')}>{t('alerts.actions.deleteItem')}</MenuItem>}
    </MenuList></MenuPopover>
  </Menu>;
}
