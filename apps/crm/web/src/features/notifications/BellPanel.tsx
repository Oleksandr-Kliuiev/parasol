import { Badge, Button, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowRight16Regular, CheckmarkCircle24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { EmptyState } from '../../shared/components/EmptyState';
import { formatDateTime, formatRelative } from '../../shared/utils/format';
import { IconChip } from '../admin/IconChip';
import { lookOf } from './look';
import { notificationText } from './text';
import type { Notification } from './types';

const useStyles = makeStyles({
  // The head of the panel: the title in the display type with what is new, the bulk action on the right.
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    minHeight: '36px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '16px',
    paddingRight: '12px',
    borderBottom: `1px solid ${h.line}`,
  },
  title: { display: 'flex', alignItems: 'center', gap: '8px', margin: 0, fontFamily: h.display, fontSize: '16px', lineHeight: '22px', fontWeight: 600 },
  list: { listStyle: 'none', margin: 0, padding: '6px', maxHeight: '60vh', overflowY: 'auto', display: 'grid', gap: '2px' },
  // One notice per row: its chip, the sentence and when, the whole row opens it.
  item: {
    display: 'grid',
    gridTemplateColumns: '32px minmax(0, 1fr) 8px',
    alignItems: 'start',
    columnGap: '12px',
    width: '100%',
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: '10px',
    paddingRight: '12px',
    borderRadius: '12px',
    border: 'none',
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    ':hover': { backgroundColor: h.well },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '-2px' },
  },
  text: { display: 'grid', gap: '2px', minWidth: 0, overflowWrap: 'anywhere' },
  sentence: { fontSize: '13.5px', lineHeight: '19px', fontWeight: tokens.fontWeightMedium },
  unread: { fontWeight: tokens.fontWeightSemibold },
  meta: { color: h.muted, fontSize: '12px', lineHeight: '16px', fontVariantNumeric: 'tabular-nums' },
  // The unread mark at the end of the row; the bold sentence says the same.
  dot: { width: '8px', height: '8px', marginTop: '6px', borderRadius: '50%', backgroundColor: h.ember },
  footer: { display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '8px', paddingBottom: '8px', paddingLeft: '12px', paddingRight: '12px', borderTop: `1px solid ${h.line}` },
  seeAll: { marginLeft: 'auto' },
});

interface BellPanelProps {
  items: Notification[];
  unread: number;
  onOpen: (notification: Notification) => void;
  onMarkAllRead: () => void;
  onSeeAll: () => void;
}

/** The content of the bell's popover, loaded when it first opens: the shell's first download stays small. */
export default function BellPanel({ items, unread, onOpen, onMarkAllRead, onSeeAll }: BellPanelProps) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <>
      <div className={styles.head}>
        <h2 className={styles.title}>
          {t('notifications.title')}
          {unread > 0 && (
            <Badge appearance="tint" color="brand">
              {t('notifications.newCount', { count: unread })}
            </Badge>
          )}
        </h2>
      </div>
      {items.length === 0 ? (
        <EmptyState message={t('notifications.empty')} icon={<CheckmarkCircle24Regular />} />
      ) : (
        <ul className={styles.list}>
          {items.map((notification) => {
            const look = lookOf(notification);
            return (
              <li key={notification.id}>
                <button type="button" className={styles.item} onClick={() => onOpen(notification)}>
                  <IconChip icon={look.icon} tone={look.tone} small />
                  <span className={styles.text}>
                    <span className={mergeClasses(styles.sentence, notification.isUnread && styles.unread)}>{notificationText(notification, t)}</span>
                    <Text className={styles.meta}>
                      <time dateTime={notification.createdAt} title={formatDateTime(notification.createdAt)}>{formatRelative(notification.createdAt)}</time>
                    </Text>
                  </span>
                  {notification.isUnread ? <span className={styles.dot} aria-label={t('notifications.new')} role="img" /> : <span />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* Clearing every notice is the panel's last control, not its first: the focus the popover gives on opening lands
          on the newest notice, so Enter, Enter opens it instead of marking everything read. */}
      <div className={styles.footer}>
        {unread > 0 && (
          <Button size="small" appearance="subtle" onClick={onMarkAllRead}>
            {t('notifications.markAllRead')}
          </Button>
        )}
        <Button className={styles.seeAll} appearance="subtle" size="small" icon={<ArrowRight16Regular />} iconPosition="after" onClick={onSeeAll}>
          {t('notifications.seeAll')}
        </Button>
      </div>
    </>
  );
}
