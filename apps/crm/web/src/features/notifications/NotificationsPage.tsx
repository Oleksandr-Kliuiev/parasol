import { useState } from 'react';
import { useHref, useLinkClickHandler, useNavigate } from 'react-router';
import {
  Badge,
  Button,
  Spinner,
  Switch,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { Alert16Regular, CheckmarkCircle20Regular, CheckmarkCircle24Regular, Mail16Regular, Settings20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { IconChip } from '../admin/settingsUi';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { formatDateTime, formatRelative } from '../../shared/utils/format';
import { useNotificationActions, useNotificationPages } from './api';
import { lookOf } from './look';
import { notificationText } from './text';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0 },
  // One quiet row per notice, like the task rows of the reference: chip, text and time, then the pill and the actions.
  row: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: '12px',
    rowGap: '8px',
    paddingTop: '12px',
    paddingBottom: '12px',
    borderTop: `1px solid ${h.line}`,
    ':first-child': { borderTop: 'none', paddingTop: '4px' },
    '@media (max-width: 560px)': { alignItems: 'start' },
  },
  chip: { position: 'relative', display: 'grid' },
  // The unread mark on the chip's corner; the "New" pill says the same in words.
  dot: {
    position: 'absolute',
    top: '-3px',
    right: '-3px',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: h.ember,
    boxShadow: `0 0 0 2px ${tokens.colorNeutralBackground1}`,
  },
  text: { display: 'grid', gap: '2px', minWidth: 0, overflowWrap: 'anywhere' },
  title: { fontSize: '14px', lineHeight: '20px', fontWeight: tokens.fontWeightMedium },
  unread: { fontWeight: tokens.fontWeightSemibold },
  meta: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '10px',
    rowGap: '2px',
    color: h.muted,
    fontSize: '12.5px',
    lineHeight: '18px',
    fontVariantNumeric: 'tabular-nums',
    '& svg': { flexShrink: 0, color: h.faint },
  },
  metaItem: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
  aside: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    justifySelf: 'end',
    '@media (max-width: 560px)': { gridColumn: '2 / -1', justifySelf: 'start', flexWrap: 'wrap' },
  },
});

/** The e-mail settings on the account page. */
const SETTINGS = '/account#notifications';

/** Everything waiting for the signed-in user (docs/02 §4.11); what they want by e-mail is set on their account page. */
export function NotificationsPage() {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const notify = useNotify();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const pages = useNotificationPages(unreadOnly);
  const { error, isPending, refetch } = pages;
  const data = pages.latest ? { ...pages.latest, items: pages.items } : undefined;
  const actions = useNotificationActions();
  const settingsHref = useHref(SETTINGS);
  const openSettings = useLinkClickHandler<HTMLAnchorElement>(SETTINGS);

  return (
    <>
      <PageHeader
        title={t('notifications.title')}
        subtitle={t('notifications.subtitle')}
        actions={
          <>
            {(data?.unread ?? 0) > 0 && (
              <Button
                icon={<CheckmarkCircle20Regular />}
                onClick={() => void actions.markAllRead.mutateAsync().then(() => notify(t('notifications.allRead')))}
              >
                {t('notifications.markAllRead')}
              </Button>
            )}
            <Button as="a" href={settingsHref} icon={<Settings20Regular />} onClick={openSettings}>
              {t('notifications.settings')}
            </Button>
          </>
        }
      />

      <Panel title={t('notifications.inbox')} icon={<Alert16Regular />} actions={<Switch label={t('notifications.unreadOnly')} checked={unreadOnly} onChange={(_, d) => setUnreadOnly(d.checked)} />}>
        {isPending && <Spinner label={t('common.loading')} />}
        {error && <ErrorState error={error} onRetry={() => void refetch()} />}
        {!isPending && !error && (data?.items.length ?? 0) === 0 && (
          <EmptyState message={unreadOnly ? t('notifications.emptyUnread') : t('notifications.empty')} icon={<CheckmarkCircle24Regular />} />
        )}
        <ul className={styles.list}>
          {(data?.items ?? []).map((notification) => {
            const look = lookOf(notification);
            return (
            <li key={notification.id} className={styles.row}>
              <span className={styles.chip}>
                <IconChip icon={look.icon} tone={look.tone} />
                {notification.isUnread && <span className={styles.dot} aria-hidden />}
              </span>
              <span className={styles.text}>
                <Text className={mergeClasses(styles.title, notification.isUnread && styles.unread)}>{notificationText(notification, t)}</Text>
                <span className={styles.meta}>
                  <time dateTime={notification.createdAt} title={formatDateTime(notification.createdAt)}>{formatRelative(notification.createdAt)}</time>
                  {notification.emailStatus === 'Sent' && (
                    <span className={styles.metaItem}>
                      <Mail16Regular aria-hidden />
                      {t('notifications.emailed')}
                    </span>
                  )}
                  {notification.emailStatus === 'Suppressed' && <span>{t('notifications.notEmailed')}</span>}
                </span>
              </span>
              <span className={styles.aside}>
                {notification.isUnread && (
                  <Badge appearance="tint" color="brand">
                    {t('notifications.new')}
                  </Badge>
                )}
                {/* A real link (it opens in a new tab like any link), named by the notice it opens: six "Open"s read alike. */}
                {notification.link && (
                  <Button
                    as="a"
                    size="small"
                    href={notification.link}
                    aria-label={`${t('common.open')}: ${notificationText(notification, t)}`}
                    onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      if (notification.isUnread) void actions.markRead.mutateAsync(notification.id);
                      navigate(notification.link!);
                    }}
                  >
                    {t('common.open')}
                  </Button>
                )}
                {notification.isUnread && (
                  <Button
                    size="small"
                    appearance="subtle"
                    aria-label={t('notifications.markReadNamed', { text: notificationText(notification, t) })}
                    icon={<CheckmarkCircle20Regular />}
                    onClick={() => void actions.markRead.mutateAsync(notification.id)}
                  />
                )}
              </span>
            </li>
            );
          })}
        </ul>
        <ListFooter shown={pages.items.length} total={pages.latest?.totalCount} hasMore={pages.hasNextPage} loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
      </Panel>
    </>
  );
}
