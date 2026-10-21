import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Badge, Button, Popover, PopoverSurface, PopoverTrigger, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Alert20Regular } from '../../app/shellIcons';
import { useTranslation } from 'react-i18next';
import { useNotify } from '../../shared/components/useNotify';
import { useNotificationActions, useNotifications } from './api';
import type { Notification } from './types';

// The list is shown only when the bell is opened: it loads then, not with the shell (scripts/bundle-budget.mjs). The
// popover opens once the list is there: its focus trap moves focus to the first control as it opens, and a trap that
// focus never entered stays hidden from screen readers while focus is left on the bell.
type Panel = { View: typeof import('./BellPanel').default } | { failed: true };

const useStyles = makeStyles({
  // Fluent clips a button's content to its box; the count sits on the corner, half outside it.
  trigger: { position: 'relative', overflow: 'visible' },
  count: { position: 'absolute', top: '-6px', right: '-6px', boxShadow: `0 0 0 2px ${tokens.colorNeutralBackground2}` },
  surface: { width: '380px', maxWidth: 'calc(100vw - 32px)', padding: 0, overflow: 'hidden' },
  failed: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '16px' },
});

/** The bell in the header: what is waiting, newest and warnings first (FR-ACT-04). */
export function NotificationsBell() {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>();
  const { data } = useNotifications(false, 15);
  const actions = useNotificationActions();
  const unread = data?.unread ?? 0;

  const loadPanel = () =>
    import('./BellPanel').then(
      (module) => setPanel({ View: module.default }),
      () => setPanel({ failed: true }),
    );
  // Pointing at the bell or tabbing to it starts the download, so the click rarely waits for it.
  const preload = () => {
    if (!panel || 'failed' in panel) void loadPanel();
  };

  // The notice opens at once; marking it read follows, and a failure to mark it (read-only maintenance, a lost
  // connection) is said instead of leaving the person with a closed popover and nothing opened.
  const openNotification = (notification: Notification) => {
    setOpen(false);
    if (notification.link) navigate(notification.link);
    if (notification.isUnread) actions.markRead.mutateAsync(notification.id).catch(() => notify(t('notifications.markReadFailed'), 'warning'));
  };

  return (
    <Popover
      open={open}
      onOpenChange={(_, d) => {
        if (!d.open || (panel && 'View' in panel)) setOpen(d.open);
        else void loadPanel().then(() => setOpen(true));
      }}
      positioning="below-end"
      trapFocus
    >
      <PopoverTrigger disableButtonEnhancement>
        <Button
          className={styles.trigger}
          icon={<Alert20Regular />}
          aria-label={unread > 0 ? t('notifications.openWithCount', { count: unread }) : t('notifications.open')}
          onPointerEnter={preload}
          onFocus={preload}
        >
          {unread > 0 && (
            <Badge className={styles.count} size="small" appearance="filled" color="danger">
              {unread}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverSurface className={styles.surface} aria-label={t('notifications.title')}>
        {panel && 'View' in panel ? (
          <panel.View
            items={data?.items ?? []}
            unread={unread}
            onOpen={openNotification}
            onMarkAllRead={() => void actions.markAllRead.mutateAsync()}
            onSeeAll={() => {
              setOpen(false);
              navigate('/notifications');
            }}
          />
        ) : (
          <div className={styles.failed}>
            <Text>{t('errors.generic')}</Text>
            <Button size="small" onClick={() => void loadPanel()}>
              {t('common.retry')}
            </Button>
          </div>
        )}
      </PopoverSurface>
    </Popover>
  );
}
