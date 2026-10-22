import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Button, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { MoreHorizontal20Regular } from '@fluentui/react-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ActionDialog } from '../../actions/ActionDialog';
import { ActionList } from '../../actions/ActionLog';
import type { VendorAction } from '../../actions/types';
import { AlertActionsContext, alertRequest, useAlertActions, useAlertSourceKinds, type AlertLike, type AlertSourceKind } from './alertSourceActions';
import { sourceName } from './alertText';

const useStyles = makeStyles({
  section: { display: 'grid', gap: '8px', minWidth: 0 },
  heading: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 700 },
  buttons: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  log: { marginLeft: '-20px', marginRight: '-20px', '@media (max-width: 600px)': { marginLeft: '-16px', marginRight: '-16px' } },
});

/**
 * Holds the confirmation of an alert action outside the rows of a list, as AlertTaskDialogHost does for the assign dialog: a row is
 * drawn again when the list reloads, and a dialog inside it would vanish while the action is followed. A finished change reads the
 * alerts again, everywhere they are shown.
 */
export function AlertActionsHost({ children }: { children: ReactNode }) {
  const { t } = useTranslation(); const client = useQueryClient();
  const [asked, setAsked] = useState<{ alert: AlertLike; kind: AlertSourceKind } | null>(null);
  const ask = useCallback((alert: AlertLike, kind: AlertSourceKind) => setAsked({ alert, kind }), []);
  const value = useMemo(() => ({ ask }), [ask]);
  const finished = (action: VendorAction) => {
    if (action.status === 'Succeeded' || action.status === 'Skipped') void client.invalidateQueries({ queryKey: ['service', 'alerts'] });
  };
  return <AlertActionsContext.Provider value={value}>
    {children}
    <ActionDialog request={asked ? alertRequest(asked.alert, asked.kind) : null}
      title={asked ? t(asked.kind === 'alert.delete' ? 'alerts.actions.deleteTitle' : 'alerts.actions.resolveTitle') : ''}
      confirm={asked ? t(asked.kind === 'alert.delete' ? 'alerts.actions.delete' : 'alerts.actions.resolve') : ''}
      onClose={() => setAsked(null)} onFinished={finished} />
  </AlertActionsContext.Provider>;
}

/**
 * The alert's own panel (M40): what can be done with it at its source, as buttons, and the actions already asked for it. The panel
 * stays open while the list behind it reloads, so it holds its confirmation itself.
 */
export function AlertSourceSection({ alert }: { alert: AlertLike }) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient(); const restore = useRestoreFocusTarget();
  const kinds = useAlertSourceKinds(alert);
  const [kind, setKind] = useState<AlertSourceKind | null>(null);
  const id = `alert-source-${alert.id}`; const source = sourceName(t, alert.system);
  const finished = (action: VendorAction) => {
    if (action.status === 'Succeeded' || action.status === 'Skipped') void client.invalidateQueries({ queryKey: ['service', 'alerts'] });
  };
  return <section className={styles.section} aria-labelledby={id}>
    <h3 id={id} className={styles.heading}>{t('alerts.actions.heading', { source })}</h3>
    {kinds.length > 0 && <span className={styles.buttons}>
      {kinds.includes('alert.resolve') && <Button {...restore} size="small" onClick={() => setKind('alert.resolve')}>{t('alerts.actions.resolve')}</Button>}
      {kinds.includes('alert.delete') && <Button {...restore} size="small" appearance="subtle" onClick={() => setKind('alert.delete')}>{t('alerts.actions.deleteItem')}</Button>}
    </span>}
    <div className={styles.log}>
      <ActionList filters={{ targetType: 'alert', targetId: alert.externalId }} showTarget={false} limit={5} empty={t('alerts.actions.none')} />
    </div>
    <ActionDialog request={kind ? alertRequest(alert, kind) : null}
      title={kind ? t(kind === 'alert.delete' ? 'alerts.actions.deleteTitle' : 'alerts.actions.resolveTitle') : ''}
      confirm={kind ? t(kind === 'alert.delete' ? 'alerts.actions.delete' : 'alerts.actions.resolve') : ''}
      onClose={() => setKind(null)} onFinished={finished} />
  </section>;
}

/** A row's menu of what can be done with its alert at the source; nothing when nothing can. */
export function AlertActionsMenu({ alert }: { alert: AlertLike }) {
  const { t } = useTranslation(); const restore = useRestoreFocusTarget();
  const { ask } = useAlertActions();
  const kinds = useAlertSourceKinds(alert);
  if (kinds.length === 0) return null;
  return <Menu positioning="below-end">
    <MenuTrigger disableButtonEnhancement>
      <Button {...restore} size="small" appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={t('alerts.actions.menu', { title: alert.title })} />
    </MenuTrigger>
    <MenuPopover><MenuList>
      {kinds.includes('alert.resolve') && <MenuItem onClick={() => ask(alert, 'alert.resolve')}>{t('alerts.actions.resolve')}</MenuItem>}
      {kinds.includes('alert.delete') && <MenuItem onClick={() => ask(alert, 'alert.delete')}>{t('alerts.actions.deleteItem')}</MenuItem>}
    </MenuList></MenuPopover>
  </Menu>;
}
