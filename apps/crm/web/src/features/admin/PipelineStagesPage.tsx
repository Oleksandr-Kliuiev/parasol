import { useState } from 'react';
import {
  Badge,
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  makeStyles,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { Add20Regular, Edit16Regular, TaskListLtr24Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useSaveStage, useStages } from '../sales/api';
import type { Stage } from '../sales/types';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { useTableCardStyles } from './tableCard';

const useStyles = makeStyles({
  order: { color: h.muted, fontVariantNumeric: 'tabular-nums', width: '72px' },
  name: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', minWidth: 0 },
  // The win probability as a number with a short bar, so the funnel reads at a glance.
  probability: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
  track: { flex: '1 1 auto', maxWidth: '120px', height: '6px', borderRadius: '999px', backgroundColor: h.well, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: '999px', backgroundColor: h.ember },
  value: { minWidth: '44px', textAlign: 'end', fontVariantNumeric: 'tabular-nums' },
  actions: { width: '96px' },
  // The stage form: the name on its own line, the two numbers side by side, the switch on the line of the controls.
  form: { display: 'grid', gap: '14px' },
  pair: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '14px', '@media (max-width: 480px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
});

/** Pipeline stages: the order and win probability behind the forecast (FR-SAL-02). */
export function PipelineStagesPage() {
  const styles = useStyles();
  const table = useTableCardStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.salesWrite);
  const { data = [], error, isPending, refetch } = useStages(true);
  const [editing, setEditing] = useState<Stage | 'new' | null>(null);
  const shown = useKeptWhileClosing(editing);
  const restoreFocusTarget = useRestoreFocusTarget();

  return (
    <>
      <PageHeader
        back={{ to: '/pipeline', label: t('pipeline.title') }}
        title={t('pipeline.stages.title')}
        subtitle={t('pipeline.stages.subtitle')}
        actions={
          canWrite && (
            <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setEditing('new')}>
              {t('pipeline.stages.new')}
            </Button>
          )
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollTable>
          <Table className={table.min720} aria-label={t('pipeline.stages.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className={styles.order}>{t('pipeline.stages.order')}</TableHeaderCell>
                <TableHeaderCell>{t('pipeline.stages.name')}</TableHeaderCell>
                <TableHeaderCell>{t('pipeline.stages.probability')}</TableHeaderCell>
                <TableHeaderCell className={table.numberHead}>{t('pipeline.stages.openDeals')}</TableHeaderCell>
                <TableHeaderCell>{t('common.status')}</TableHeaderCell>
                {canWrite && <TableHeaderCell className={styles.actions} />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((stage) => (
                <TableRow key={stage.id}>
                  <TableCell className={styles.order}>{stage.order}</TableCell>
                  <TableCell>
                    <span className={styles.name}>
                      <span className={table.name}>{stage.name}</span>
                      {(stage.isWon || stage.isLost) && (
                        <Badge appearance="tint" color={stage.isWon ? 'success' : 'danger'}>
                          {t(stage.isWon ? 'opportunities.statuses.Won' : 'opportunities.statuses.Lost')}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className={styles.probability}>
                      <span className={styles.value}>{stage.probability} %</span>
                      <span className={styles.track} aria-hidden>
                        <span className={styles.fill} style={{ display: 'block', width: `${Math.min(100, Math.max(0, stage.probability))}%` }} />
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className={table.number}>{stage.openOpportunities}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" color={stage.isActive ? 'success' : 'subtle'}>
                      {stage.isActive ? t('common.active') : t('common.inactive')}
                    </Badge>
                  </TableCell>
                  {canWrite && (
                    <TableCell className={styles.actions}>
                      <span className={table.rowActions}>
                        <Button {...restoreFocusTarget} size="small" appearance="subtle" icon={<Edit16Regular />} onClick={() => setEditing(stage)}>
                          {t('common.edit')}
                        </Button>
                      </span>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && data.length === 0 && <EmptyState message={t('pipeline.stages.empty')} icon={<TaskListLtr24Regular />} />}
        </ScrollTable>
      )}

      <Dialog open={editing !== null} onOpenChange={(_, d) => !d.open && setEditing(null)}>
        <DialogSurface>
          {shown !== null && (
            <StageForm
              stage={shown === 'new' ? null : shown}
              nextOrder={(data.reduce((max, s) => Math.max(max, s.order), 0) ?? 0) + 10}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogSurface>
      </Dialog>
    </>
  );
}

function StageForm({ stage, nextOrder, onClose }: { stage: Stage | null; nextOrder: number; onClose: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const save = useSaveStage();
  const [name, setName] = useState(stage?.name ?? '');
  const [probability, setProbability] = useState(String(stage?.probability ?? 50));
  const [order, setOrder] = useState(String(stage?.order ?? nextOrder));
  const [isActive, setIsActive] = useState(stage?.isActive ?? true);

  const submit = async () => {
    try {
      await save.mutateAsync({
        id: stage?.id,
        etag: stage?.etag,
        name: name.trim(),
        probability: Number(probability),
        order: Number(order),
        isActive,
      });
      notify(t('pipeline.stages.saved', { name: name.trim() }));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <DialogBody>
      <DialogTitle>{stage ? t('pipeline.stages.edit') : t('pipeline.stages.new')}</DialogTitle>
      <DialogContent className={styles.form}>
        <Field label={t('pipeline.stages.name')} required>
          <Input value={name} onChange={(_, d) => setName(d.value)} />
        </Field>
        <div className={styles.pair}>
          <Field label={t('pipeline.stages.probability')} hint={t('pipeline.stages.probabilityHint')}>
            <Input type="number" min={0} max={100} value={probability} onChange={(_, d) => setProbability(d.value)} />
          </Field>
          <Field label={t('pipeline.stages.order')}>
            <Input type="number" min={0} value={order} onChange={(_, d) => setOrder(d.value)} />
          </Field>
        </div>
        <Switch label={t('common.active')} checked={isActive} onChange={(_, d) => setIsActive(d.checked)} />
        {stage && (stage.isWon || stage.isLost) && (
          <MessageBar intent="info">
            <MessageBarBody>{t('pipeline.stages.closedStageHint')}</MessageBarBody>
          </MessageBar>
        )}
        {save.error && (
          <MessageBar intent="error">
            <MessageBarBody>{errorMessage(save.error, t)}</MessageBarBody>
          </MessageBar>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button appearance="primary" disabled={!name.trim() || save.isPending} onClick={() => void submit()}>
          {t('common.save')}
        </Button>
      </DialogActions>
    </DialogBody>
  );
}
