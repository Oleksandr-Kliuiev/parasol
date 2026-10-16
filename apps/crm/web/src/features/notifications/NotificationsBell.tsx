import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Button,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Alert20Regular, Warning20Filled } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../../shared/utils/format';
import { useNotificationActions, useNotifications } from './api';
import { notificationText } from './text';
import type { Notification } from './types';

const useStyles = makeStyles({
  trigger: { position: 'relative' },
  count: { position: 'absolute', top: '2px', right: '2px' },
  surface: { width: '360px', maxWidth: 'calc(100vw - 32px)', padding: 0 },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    paddingInline: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  list: { listStyle: 'none', margin: 0, padding: 0, maxHeight: '60vh', overflowY: 'auto' },
  item: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'flex-start',
    paddingInline: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
  button: {
    display: 'block',
    width: '100%',
    textAlign: 'start',
    backgroundColor: 'transparent',
    borderTopStyle: 'none',
    borderRightStyle: 'none',
    borderBottomStyle: 'none',
    borderLeftStyle: 'none',
    paddingInline: 0,
    paddingBlock: 0,
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    color: 'inherit',
    cursor: 'pointer',
  },
  unread: { fontWeight: tokens.fontWeightSemibold },
  meta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  warning: { color: tokens.colorPaletteDarkOrangeForeground1 },
  empty: { padding: tokens.spacingHorizontalM, color: tokens.colorNeutralForeground3 },
  footer: { padding: tokens.spacingHorizontalS, borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
});

/** The bell in the header: what is waiting, newest and warnings first (FR-ACT-04). */
export function NotificationsBell() {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data } = useNotifications(false, 15);
  const actions = useNotificationActions();
  const unread = data?.unread ?? 0;

  const openNotification = async (notification: Notification) => {
    setOpen(false);
    if (notification.isUnread) await actions.markRead.mutateAsync(notification.id);
    if (notification.link) navigate(notification.link);
  };

  return (
    <Popover open={open} onOpenChange={(_, d) => setOpen(d.open)} positioning="below-end" trapFocus>
      <PopoverTrigger disableButtonEnhancement>
        <Button
          className={styles.trigger}
          appearance="subtle"
          icon={<Alert20Regular />}
          aria-label={unread > 0 ? t('notifications.openWithCount', { count: unread }) : t('notifications.open')}
        >
          {unread > 0 && (
            <Badge className={styles.count} size="small" appearance="filled" color="danger">
              {unread}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverSurface className={styles.surface}>
        <div className={styles.head}>
          <Text weight="semibold">{t('notifications.title')}</Text>
          {unread > 0 && (
            <Button size="small" appearance="subtle" onClick={() => void actions.markAllRead.mutateAsync()}>
              {t('notifications.markAllRead')}
            </Button>
          )}
        </div>
        {(data?.items.length ?? 0) === 0 ? (
          <Text className={styles.empty}>{t('notifications.empty')}</Text>
        ) : (
          <ul className={styles.list}>
            {(data?.items ?? []).map((notification) => (
              <li key={notification.id} className={styles.item}>
                {notification.warning && <Warning20Filled className={styles.warning} aria-hidden />}
                <button type="button" className={styles.button} onClick={() => void openNotification(notification)}>
                  <span className={notification.isUnread ? styles.unread : undefined}>{notificationText(notification, t)}</span>
                  <span className={styles.meta} style={{ display: 'block' }}>
                    {formatDateTime(notification.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.footer}>
          <Button
            appearance="subtle"
            onClick={() => {
              setOpen(false);
              navigate('/notifications');
            }}
          >
            {t('notifications.seeAll')}
          </Button>
        </div>
      </PopoverSurface>
    </Popover>
  );
}
