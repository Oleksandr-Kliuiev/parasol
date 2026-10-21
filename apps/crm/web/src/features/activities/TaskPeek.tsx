import type { ReactNode } from 'react';
import { Button, DrawerBody, DrawerHeader, DrawerHeaderTitle, OverlayDrawer, Text, makeStyles } from '@fluentui/react-components';
import { ArrowRight16Regular, Dismiss24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { DetailList } from '../../shared/components/Panel';
import { formatDateTime } from '../../shared/utils/format';
import { activityUrl } from './activityNavigation';
import type { Activity } from './types';

const useStyles = makeStyles({
  // A side panel beside the list, not over all of it: the person keeps their place in My day (Fluent Drawer guidance).
  drawer: { width: 'min(480px, 100vw)' },
  body: { display: 'grid', gap: '20px', alignContent: 'start', paddingBottom: '24px' },
  facts: { gridTemplateColumns: 'minmax(0, 132px) minmax(0, 1fr)' },
  overdue: { color: h.emberT, fontWeight: 600 },
  sectionTitle: { margin: 0, marginBottom: '6px', color: h.muted, fontSize: '12.5px', fontWeight: 600 },
  description: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '14px', lineHeight: '21px' },
  none: { color: h.muted },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  open: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 600, minHeight: '24px' },
});

/**
 * One of my open tasks in a side panel (UX 2026, В5): what the row leaves out (description, contact, place, who created
 * it) and the row's own actions, with the way to the customer's full timeline. It shows the task as the list last read
 * it; a task the list no longer holds is said to be gone from it, not looked up again here.
 */
export function TaskPeek({ activity, open, onClose, actions }: {
  activity: Activity | null; open: boolean; onClose: () => void; actions?: ReactNode;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <OverlayDrawer className={styles.drawer} position="end" open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}
      aria-label={activity ? activity.subject : t('myDay.taskPeek.gone')}>
      <DrawerHeader>
        <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label={t('common.close')} onClick={onClose} />}>
          {activity ? activity.subject : t('myDay.taskPeek.gone')}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={styles.body}>
        {!activity ? <Text block>{t('myDay.taskPeek.goneNote')}</Text> : <>
          {/* The facts a task always has, then the optional ones only when set: no rows of dashes. */}
          <DetailList className={styles.facts} items={[
            { label: t('myDay.taskPeek.customer'), value: <AppLink to={`/organizations/${activity.organizationId}`}>{activity.organizationName}</AppLink> },
            { label: t('myDay.taskPeek.due'), value: !activity.dueAt ? <span className={styles.none}>{t('myDay.taskPeek.noDue')}</span>
              : activity.isOverdue ? <span className={styles.overdue}>{t('activities.overdueAt', { at: formatDateTime(activity.dueAt) })}</span>
              : formatDateTime(activity.dueAt) },
            { label: t('myDay.taskPeek.priority'), value: t(`activities.priorities.${activity.priority}`) },
            ...(activity.contactName ? [{ label: t('myDay.taskPeek.contact'), value: activity.contactName }] : []),
            ...(activity.location ? [{ label: t('myDay.taskPeek.location'), value: activity.location }] : []),
            { label: t('myDay.taskPeek.created'), value: [activity.createdBy?.name, formatDateTime(activity.createdAt)].filter(Boolean).join(' · ') },
          ]} />
          <section>
            <h3 className={styles.sectionTitle}>{t('myDay.taskPeek.description')}</h3>
            {activity.body
              ? <p className={styles.description}>{activity.body}</p>
              // A task made from an alert has no description of its own: its Source shows the alert as it is now.
              : <p className={`${styles.description} ${styles.none}`}>{t(activity.hasTechnicalSource ? 'activities.source.noDescription' : 'myDay.taskPeek.noDescription')}</p>}
          </section>
          {actions && <div className={styles.actions}>{actions}</div>}
          <AppLink className={styles.open} to={activityUrl(activity.organizationId, activity.id)}>
            {t('myDay.taskPeek.openInCard')}<ArrowRight16Regular aria-hidden />
          </AppLink>
        </>}
      </DrawerBody>
    </OverlayDrawer>
  );
}
