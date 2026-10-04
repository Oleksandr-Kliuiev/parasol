import { useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Badge,
  Button,
  Checkbox,
  Field,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Switch,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CheckmarkCircle20Regular, Warning20Filled } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../shared/components/EmptyState';
import { ListFooter } from '../../shared/components/ListFooter';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useNotificationActions, useNotificationPages, useNotificationPreferences, useSaveNotificationPreferences } from './api';
import { notificationText } from './text';
import { notificationKinds, type NotificationKind } from './types';

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)',
    gap: tokens.spacingHorizontalL,
    alignItems: 'start',
    '@media (max-width: 900px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  list: { listStyle: 'none', margin: 0, padding: 0 },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    ':last-child': { borderBottom: 'none' },
  },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, gap: tokens.spacingVerticalXXS },
  unread: { fontWeight: tokens.fontWeightSemibold },
  meta: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  warning: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-start', color: tokens.colorPaletteDarkOrangeForeground1 },
  kinds: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS },
  actions: { display: 'flex', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM },
});

/** Everything waiting for the signed-in user, and what they want to be told by e-mail (docs/02 §4.11). */
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

  return (
    <>
      <PageHeader
        title={t('notifications.title')}
        subtitle={t('notifications.subtitle')}
        actions={
          (data?.unread ?? 0) > 0 && (
            <Button
              icon={<CheckmarkCircle20Regular />}
              onClick={() => void actions.markAllRead.mutateAsync().then(() => notify(t('notifications.allRead')))}
            >
              {t('notifications.markAllRead')}
            </Button>
          )
        }
      />

      <div className={styles.grid}>
        <Panel title={t('notifications.inbox')} actions={<Switch label={t('notifications.unreadOnly')} checked={unreadOnly} onChange={(_, d) => setUnreadOnly(d.checked)} />}>
          {isPending && <Spinner label={t('common.loading')} />}
          {error && <ErrorState error={error} onRetry={() => void refetch()} />}
          {!isPending && !error && (data?.items.length ?? 0) === 0 && <EmptyState message={t('notifications.empty')} />}
          <ul className={styles.list}>
            {(data?.items ?? []).map((notification) => (
              <li key={notification.id} className={styles.row}>
                <span className={notification.warning ? styles.warning : styles.text}>
                  {notification.warning && <Warning20Filled aria-hidden />}
                  <span className={styles.text}>
                    <Text className={notification.isUnread ? styles.unread : undefined}>{notificationText(notification, t)}</Text>
                    <Text className={styles.meta}>
                      {formatDateTime(notification.createdAt)}
                      {notification.emailStatus === 'Sent' ? ` · ${t('notifications.emailed')}` : ''}
                      {notification.emailStatus === 'Suppressed' ? ` · ${t('notifications.notEmailed')}` : ''}
                    </Text>
                  </span>
                </span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {notification.isUnread && (
                    <Badge appearance="outline" color="informative">
                      {t('notifications.new')}
                    </Badge>
                  )}
                  {notification.link && (
                    <Button
                      size="small"
                      onClick={() => {
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
            ))}
          </ul>
          <ListFooter shown={pages.items.length} total={pages.latest?.totalCount} hasMore={pages.hasNextPage} loading={pages.isFetchingNextPage} onMore={() => void pages.fetchNextPage()} />
        </Panel>

        <PreferencesPanel />
      </div>
    </>
  );
}

function PreferencesPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const { data, isPending } = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const [draft, setDraft] = useState<{ emailEnabled: boolean; digestHour: number; mutedKinds: NotificationKind[] } | null>(null);
  const current = draft ?? (data ? { emailEnabled: data.emailEnabled, digestHour: data.digestHour, mutedKinds: data.mutedKinds } : null);

  const submit = async () => {
    if (!current) return;
    try {
      await save.mutateAsync(current);
      setDraft(null);
      notify(t('notifications.preferencesSaved'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Panel title={t('notifications.preferences')}>
      {isPending || !current ? (
        <Spinner label={t('common.loading')} />
      ) : (
        <>
          {!data?.emailAvailable && (
            <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
              <MessageBarBody>{t('notifications.emailUnavailable')}</MessageBarBody>
            </MessageBar>
          )}
          <Switch
            label={t('notifications.emailEnabled')}
            checked={current.emailEnabled}
            disabled={!data?.emailAvailable}
            onChange={(_, d) => setDraft({ ...current, emailEnabled: d.checked })}
          />
          <Field label={t('notifications.digestHour')} hint={t('notifications.digestHourHint')}>
            <Select
              value={String(current.digestHour)}
              disabled={!current.emailEnabled || !data?.emailAvailable}
              onChange={(_, d) => setDraft({ ...current, digestHour: Number(d.value) })}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {`${String(hour).padStart(2, '0')}:00`}
                </option>
              ))}
            </Select>
          </Field>
          <Text weight="semibold" style={{ display: 'block', marginTop: tokens.spacingVerticalM }}>
            {t('notifications.muted')}
          </Text>
          <div className={styles.kinds}>
            {notificationKinds.map((kind) => (
              <Checkbox
                key={kind}
                label={t(`notifications.kindNames.${kind}`)}
                checked={!current.mutedKinds.includes(kind)}
                onChange={(_, d) =>
                  setDraft({
                    ...current,
                    mutedKinds: d.checked ? current.mutedKinds.filter((k) => k !== kind) : [...current.mutedKinds, kind],
                  })
                }
              />
            ))}
          </div>
          <div className={styles.actions}>
            <Button appearance="primary" disabled={draft === null || save.isPending} onClick={() => void submit()}>
              {t('common.save')}
            </Button>
            {draft !== null && <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>}
          </div>
        </>
      )}
    </Panel>
  );
}
