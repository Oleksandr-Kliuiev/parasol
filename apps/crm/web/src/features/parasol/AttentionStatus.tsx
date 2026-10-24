import { MessageBar, MessageBarBody, Spinner, Text, mergeClasses } from '@fluentui/react-components';
import { CheckmarkCircle16Filled, Warning16Filled } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { FactGrid } from '../../shared/components/Panel';
import { formatReadAt } from '../../shared/utils/format';
import { useAttentionStyles } from './attentionStyles';
import type { AttentionRead } from './useAttentionRead';

/**
 * What the read covered, as one line in a well that is green only for a complete read and names every gap in the same box;
 * how the read works and each coverage figure sit one disclosure away (UX 2026). `note` and `previewNote` say what this
 * view does with the read.
 */
export function AttentionStatus({ read, note, previewNote }: { read: AttentionRead; note: string; previewNote: string }) {
  const { t } = useTranslation(); const own = useAttentionStyles();
  const { data, error, complete, warnings, incompleteSources } = read;
  const coverage = data?.coverage;
  return <>
    {read.checking && <Spinner size="small" label={t('common.loading')} />}
    {error && <MessageBar intent="warning" layout="multiline"><MessageBarBody><Text role="status">{t(`parasolAttention.status.${error}`)}</Text></MessageBarBody></MessageBar>}
    {data && coverage && <>
      <div className={mergeClasses(own.status, !complete && own.statusGap)}>
        <div className={own.statusLine}>
          <span className={own.statusText}>
            {complete ? <CheckmarkCircle16Filled aria-hidden className={own.completeIcon} /> : <Warning16Filled aria-hidden className={own.gapIcon} />}
            <Text>{t('parasolAttention.coverage', { ready: coverage.readyCustomers, selected: coverage.selectedCustomers })}</Text>
          </span>
          <Text className={own.checked}>{t('parasolAttention.checkedAt', { time: formatReadAt(data.checkedAt) })}</Text>
        </div>
        {warnings.map(line => <Text block className={own.statusNote} key={line}>{line}</Text>)}
      </div>
      {/* How the read works and every coverage figure: under the status it explains, read without a new request. */}
      <details className={own.details}>
        <summary className={own.summary}>{t('parasolAttention.about')}</summary>
        <div className={own.about}>
          <Text block className={own.note}>{note}</Text>
          <FactGrid items={[
            { label: t('parasolAttention.visible'), value: String(coverage.visibleClients) },
            { label: t('parasolAttention.matched'), value: String(coverage.matchedCustomers) },
            { label: t('parasolAttention.attempted'), value: String(coverage.attemptedCustomers) },
            { label: t('parasolAttention.unmapped'), value: String(coverage.unmappedClients), warn: coverage.unmappedClients > 0 },
            { label: t('parasolAttention.mappingIssues'), value: String(coverage.mappingIssues), warn: coverage.mappingIssues > 0 },
            { label: t('parasolAttention.failed'), value: String(coverage.failedCustomers), warn: coverage.failedCustomers > 0 },
            { label: t('parasolAttention.omitted'), value: String(coverage.omittedCustomers), warn: coverage.omittedCustomers > 0 },
            { label: t('parasolAttention.incompleteSources'), value: String(incompleteSources), warn: incompleteSources > 0 },
          ]} />
          <Text block className={own.note}>{previewNote}</Text>
        </div>
      </details>
    </>}
  </>;
}

