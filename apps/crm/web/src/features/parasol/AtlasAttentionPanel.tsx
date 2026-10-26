import { useId } from 'react';
import { Badge, Button, MessageBar, MessageBarBody, Text, mergeClasses } from '@fluentui/react-components';
import { ArrowClockwise16Regular, ChevronRight16Regular, Pulse20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { Panel } from '../../shared/components/Panel';
import { formatDateTime, formatReadAt } from '../../shared/utils/format';
import { attentionLimit, type AtlasAttentionCustomer } from './atlasAttentionContract';
import { AttentionStatus } from './AttentionStatus';
import { useAttentionRead } from './useAttentionRead';
import { useAttentionStyles } from './attentionStyles';
import { ObservationRows } from './ObservationRows';
import { resourceTone, useTechnicalStyles } from './technicalStyles';

export function AtlasAttentionPanel() {
  const user = useCurrentUser(); const canCustomers = useCan(Permissions.customersRead); const canAtlas = useCan(Permissions.parasolAtlasRead);
  if (!canCustomers || !canAtlas) return null;
  const permissionsKey = JSON.stringify([...user.permissions].sort());
  return <PersonalAttention key={`${user.id}:${permissionsKey}`} employeeId={user.id} permissionsKey={permissionsKey} />;
}

function PersonalAttention({ employeeId, permissionsKey }: { employeeId: string; permissionsKey: string }) {
  const { t } = useTranslation(); const styles = useTechnicalStyles(); const own = useAttentionStyles();
  const read = useAttentionRead('/api/v1/parasol/my-day/atlas-attention', attentionLimit.myDay, ['parasol', 'atlas-attention', employeeId, permissionsKey]);
  const { data, refresh, checking } = read;
  const urgent = (data?.customers ?? []).filter(c => c.status === 'READY' && c.high! + c.critical! > 0)
    .sort((a, b) => b.critical! - a.critical! || b.high! - a.high!
      || a.customerName.localeCompare(b.customerName, undefined, { sensitivity: 'base' }) || a.customerId.localeCompare(b.customerId));
  const failed = (data?.customers ?? []).filter(c => c.status !== 'READY');
  const other = (data?.customers ?? []).filter(c => c.status === 'READY' && c.high === 0 && c.critical === 0);
  return <Panel title={t('parasolAttention.title')} icon={<Pulse20Regular />} actions={<Button size="small" icon={<ArrowClockwise16Regular />}
    aria-label={t('parasolAttention.refresh')} disabled={checking} disabledFocusable={checking} onClick={refresh}>{t('common.refresh')}</Button>}>
    <div className={own.stack}>
    {/* A new read starts with closed disclosures, as the rows below do. */}
    <AttentionStatus key={`status-${read.revision}`} read={read} note={t('parasolAttention.note')} previewNote={t('parasolAttention.previewNote')} />
    {data && data.coverage && data.totals && data.customers && <div key={`rows-${read.revision}`} className={own.stack}>
      <div className={own.totals}>
        <Text block className={own.totalsLine}>{t('parasolAttention.totals', { active: data.totals.activeObservations, high: data.totals.high, critical: data.totals.critical })}</Text>
        <Text block className={own.note}>{t('parasolAttention.previewHint')}</Text>
      </div>
      {data.customers.length === 0 && <Text block role="status">{t('parasolAttention.empty')}</Text>}
      <div className={styles.list}>{[...urgent, ...failed].map(customer => <AttentionCustomer key={customer.customerId} customer={customer} checkedAt={data.checkedAt} onSourceInvalidated={refresh} />)}</div>
      {other.length > 0 && <details className={own.details}>
        <summary className={own.summary}>{t('parasolAttention.otherCustomers', { count: other.length })}</summary>
        {/* Said once for the group, not repeated in every quiet customer. */}
        <Text block className={own.note}>{t('parasolAttention.noUrgent')}</Text>
        <div className={styles.list}>{other.map(customer => <AttentionCustomer key={customer.customerId} customer={customer} checkedAt={data.checkedAt} onSourceInvalidated={refresh} />)}</div>
      </details>}
    </div>}
    </div>
  </Panel>;
}

function AttentionCustomer({ customer: c, checkedAt, onSourceInvalidated }: {
  customer: AtlasAttentionCustomer; checkedAt: string; onSourceInvalidated: () => void;
}) {
  const { t } = useTranslation(); const styles = useTechnicalStyles(); const own = useAttentionStyles(); const heading = useId();
  // A customer without urgent observations is one compact row: its name (the way in), what is incomplete, and its sources.
  const quiet = c.status === 'READY' && c.preview.length === 0;
  // Times are told only where they add to the read time above: the customer's own read, then its assembly.
  const readAt = c.retrievedAt ? formatReadAt(c.retrievedAt) : '';
  const assembledAt = c.generatedAt ? formatReadAt(c.generatedAt) : '';
  const open = <AppLink className={own.open} to={`/organizations/${c.customerId}`}>{t('parasolAttention.openCustomer')}<ChevronRight16Regular aria-hidden /></AppLink>;
  return <section className={mergeClasses(styles.row, own.customer, quiet && own.quiet)} aria-labelledby={heading}>
    <div className={own.customerHead}>
      <h3 id={heading} className={mergeClasses(styles.heading, own.customerName, quiet && own.quietName)}><AppLink to={`/organizations/${c.customerId}`}>{c.customerName}</AppLink></h3>
      {c.status === 'READY' && !quiet && <span className={own.counts} aria-hidden>
        {c.critical! > 0 && <Badge appearance="filled" color="danger">{t('parasolDetails.severity.CRITICAL')} {c.critical}</Badge>}
        {c.high! > 0 && <Badge appearance="tint" color="danger">{t('parasolDetails.severity.HIGH')} {c.high}</Badge>}
      </span>}
    </div>
    {c.status !== 'READY' ? <Text role="status">{t(`parasolAttention.customerStatus.${c.status}`)}</Text> : <>
      {c.mode === 'fixture' && <MessageBar intent="warning"><MessageBarBody>{t('parasol.fixture')}</MessageBarBody></MessageBar>}
      {/* The badges above show the counts; screen readers get them as this sentence. */}
      <Text block className={own.hidden}>{t('parasolAttention.customerCounts', { high: c.high, critical: c.critical })}</Text>
      <div className={own.meta}>
        {readAt !== formatReadAt(checkedAt) && <span>{t('parasolAttention.retrievedAt', { time: readAt })}</span>}
        {assembledAt !== readAt && <span>{t('parasol.snapshot', { time: assembledAt })}</span>}
        {c.completeness !== 'COMPLETE' && <span className={own.partial}>{t('parasolAttention.sourcePartial')}</span>}
      </div>
      {!quiet && <>
        <Text block className={own.caption}>{t('parasolAttention.previewCount', { shown: c.preview.length, total: c.high! + c.critical! })}</Text>
        {/* The tasks came with this read (one request for the whole snapshot); without them the rows say nothing about work. */}
        <ObservationRows raised items={c.preview} devices={c.devices} customerId={c.customerId} onSourceInvalidated={onSourceInvalidated}
          links={new Map(c.tasks?.map(link => [link.observationId, { task: link.task, assigneeName: link.assigneeName }]))} />
        {open}
      </>}
      <details className={own.details}>
        <summary className={own.summary}>{t('parasolAttention.sources')}</summary>
        <div className={own.sources}>
          <Text block className={own.note}>{t('parasol.coverage')}</Text>
          {c.resources?.length === 0 && <Text block className={own.note}>{t('parasol.noSources')}</Text>}
          {/* Rows, not a list: the customer's list items are its urgent observations. */}
          <div className={own.sourceRows}>{c.resources?.map((r, i) => <div className={own.sourceRow} key={`${r.source}-${r.resourceType}-${i}`}>
            <div className={own.sourceHead}>
              <Text weight="semibold">{t(`parasol.sources.${r.source}`)} · {t(`parasol.resources.${r.resourceType}`)}</Text>
              <Badge appearance="tint" color={resourceTone[r.status]}>{t(`parasol.resourceStatus.${r.status}`)}</Badge>
            </div>
            <div className={own.meta}>
              {r.asOf && <span>{t('parasol.asOf', { time: formatDateTime(r.asOf) })}</span>}
              {r.lastSuccessAt && <span>{t('parasol.lastSuccess', { time: formatDateTime(r.lastSuccessAt) })}</span>}
              {r.returnedItems !== null && <span>{t(r.truncated ? 'parasol.truncated' : 'parasol.returned', { count: r.returnedItems })}</span>}
            </div>
          </div>)}</div>
        </div>
      </details>
    </>}
  </section>;
}
