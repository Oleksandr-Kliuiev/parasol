import { useState } from 'react';
import { Button, Text, makeStyles, tokens, useRestoreFocusTarget } from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { Panel } from '../../shared/components/Panel';
import { formatDateTime } from '../../shared/utils/format';
import { ActivityDialog } from '../activities/ActivityDialog';
import { useActivities } from '../activities/api';

const useStyles = makeStyles({
  line: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  overdue: { color: tokens.colorPaletteRedForeground1 },
  warning: { color: tokens.colorPaletteDarkOrangeForeground1 },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
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
    <Panel title={t('opportunities.nextStep.title')}>
      {open.isPending ? (
        <Text className={styles.muted}>{t('common.loading')}</Text>
      ) : next ? (
        <div className={styles.line}>
          <Text weight="semibold">{next.subject}</Text>
          <Text className={next.isOverdue ? styles.overdue : styles.muted}>
            {next.dueAt ? t(next.isOverdue ? 'activities.overdueAt' : 'activities.dueAt', { at: formatDateTime(next.dueAt) }) : t('opportunities.nextStep.noDue')}
            {' · '}
            {next.assignee ? next.assignee.name : t('opportunities.nextStep.unassigned')}
          </Text>
          {(open.total ?? 0) > 1 && <Text className={styles.muted}>{t("opportunities.nextStep.more", { count: (open.total ?? 0) - 1 })}</Text>}
        </div>
      ) : (
        <Text className={styles.warning}>{t('opportunities.nextStep.none')}</Text>
      )}
      {canWrite && (
        <Button {...restoreFocusTarget} style={{ marginTop: 12 }} size="small" icon={<Add20Regular />} onClick={() => setAdding(true)}>
          {t('opportunities.nextStep.add')}
        </Button>
      )}
      <ActivityDialog open={adding} onClose={() => setAdding(false)} organizationId={organizationId} opportunityId={opportunityId} defaultType="Task" />
    </Panel>
  );
}
