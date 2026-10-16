import { useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
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
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useCatalogStyles } from '../catalog/styles';
import { useSaveStage, useStages } from '../sales/api';
import type { Stage } from '../sales/types';

/** Pipeline stages: the order and win probability behind the forecast (FR-SAL-02). */
export function PipelineStagesPage() {
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const canWrite = useCan(Permissions.salesWrite);
  const { data = [], error, isPending, refetch } = useStages(true);
  const [editing, setEditing] = useState<Stage | 'new' | null>(null);
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
        <div className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('pipeline.stages.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className={catalog.number}>{t('pipeline.stages.order')}</TableHeaderCell>
                <TableHeaderCell>{t('pipeline.stages.name')}</TableHeaderCell>
                <TableHeaderCell className={catalog.number}>{t('pipeline.stages.probability')}</TableHeaderCell>
                <TableHeaderCell className={catalog.number}>{t('pipeline.stages.openDeals')}</TableHeaderCell>
                <TableHeaderCell>{t('common.status')}</TableHeaderCell>
                {canWrite && <TableHeaderCell />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((stage) => (
                <TableRow key={stage.id}>
                  <TableCell className={catalog.number}>{stage.order}</TableCell>
                  <TableCell>
                    <span className={catalog.name}>{stage.name}</span>
                    {(stage.isWon || stage.isLost) && (
                      <div>
                        <Badge appearance="tint" color={stage.isWon ? 'success' : 'danger'}>
                          {t(stage.isWon ? 'opportunities.statuses.Won' : 'opportunities.statuses.Lost')}
                        </Badge>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className={catalog.number}>{stage.probability} %</TableCell>
                  <TableCell className={catalog.number}>{stage.openOpportunities}</TableCell>
                  <TableCell>{stage.isActive ? t('common.active') : t('common.inactive')}</TableCell>
                  {canWrite && (
                    <TableCell>
                      <Button size="small" appearance="subtle" onClick={() => setEditing(stage)}>
                        {t('common.edit')}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && data.length === 0 && <EmptyState message={t('pipeline.stages.empty')} />}
        </div>
      )}

      <Dialog open={editing !== null} onOpenChange={(_, d) => !d.open && setEditing(null)}>
        <DialogSurface>
          {editing !== null && (
            <StageForm
              stage={editing === 'new' ? null : editing}
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
      <DialogContent>
        <Field label={t('pipeline.stages.name')} required>
          <Input value={name} onChange={(_, d) => setName(d.value)} />
        </Field>
        <Field label={t('pipeline.stages.probability')} hint={t('pipeline.stages.probabilityHint')}>
          <Input type="number" min={0} max={100} value={probability} onChange={(_, d) => setProbability(d.value)} />
        </Field>
        <Field label={t('pipeline.stages.order')}>
          <Input type="number" min={0} value={order} onChange={(_, d) => setOrder(d.value)} />
        </Field>
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
