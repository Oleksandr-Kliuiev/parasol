import { useState } from 'react';
import { Button, Text, makeStyles, mergeClasses, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular, ArrowCircleRight16Regular, TaskListSquareLtr16Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { Panel } from '../../shared/components/Panel';
import { formatDateTime } from '../../shared/utils/format';
import { ActivityDialog } from '../activities/ActivityDialog';
import { useActivities } from '../activities/api';

const useStyles = makeStyles({
  // The next task as a row of the reference's task list: a tinted icon chip, the subject and a muted line.
  row: { display: 'flex', alignItems: 'flex-start', gap: '12px' },
  chip: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: '32px',
    height: '32px',
    borderRadius: '10px',
    backgroundColor: h.irisSoft,
    color: h.irisT,
  },
  chipLate: { backgroundColor: h.emberSoft, color: h.emberT },
  line: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  subject: { fontWeight: 700, overflowWrap: 'anywhere' },
  overdue: { color: h.emberT, fontSize: '13px' },
  warning: { color: h.saffronT },
  muted: { color: h.muted, fontSize: '13px' },
  add: { marginTop: '12px' },
});

/**
 * The one thing that happens next on an open deal: the earliest open task with who does it and by when, or a plain
 * "no next step" with the action to add one, so a deal is never left without an owner of its next move.
 */
export function NextStep({ organizationId, opportunityId }: { organizationId: string; opportunityId: string }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.activitiesWrite);
  const [adding, setAdding] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();
  const open = useActivities({ opportunityId, open: true }, true, 1);
  const next = open.items[0];

  return (
    <Panel title={t('opportunities.nextStep.title')} icon={<ArrowCircleRight16Regular />}>
      {open.isPending ? (
        <Text className={styles.muted}>{t('common.loading')}</Text>
      ) : next ? (
        <div className={styles.row}>
          <span className={mergeClasses(styles.chip, next.isOverdue && styles.chipLate)} aria-hidden>
            <TaskListSquareLtr16Regular />
          </span>
          <div className={styles.line}>
            <Text className={styles.subject}>{next.subject}</Text>
            <Text className={next.isOverdue ? styles.overdue : styles.muted}>
              {next.dueAt ? t(next.isOverdue ? 'activities.overdueAt' : 'activities.dueAt', { at: formatDateTime(next.dueAt) }) : t('opportunities.nextStep.noDue')}
              {' · '}
              {next.assignee ? next.assignee.name : t('opportunities.nextStep.unassigned')}
            </Text>
            {(open.total ?? 0) > 1 && <Text className={styles.muted}>{t("opportunities.nextStep.more", { count: (open.total ?? 0) - 1 })}</Text>}
          </div>
        </div>
      ) : (
        <Text block className={styles.warning}>{t('opportunities.nextStep.none')}</Text>
      )}
      {canWrite && (
        <div className={styles.add}>
          <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => setAdding(true)}>
            {t('opportunities.nextStep.add')}
          </Button>
        </div>
      )}
      <ActivityDialog open={adding} onClose={() => setAdding(false)} organizationId={organizationId} opportunityId={opportunityId} defaultType="Task" />
    </Panel>
  );
}
