import { Link, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, makeStyles } from '@fluentui/react-components';
import { DocumentPdf16Regular, Open16Regular, Shield16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Panel } from '../../shared/components/Panel';
import { formatDate, formatNumber } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { FigureGrid } from '../reports/FigureGrid';
import { AlertReadLine } from '../service/alerts/AlertReadLine';
import { sourceName } from '../service/alerts/alertText';
import { SavedServiceReadState } from '../service/SavedServiceReadState';
import { useSecurityOverview } from './api';
import type { SummaryReport, Usage } from './types';

const useStyles = makeStyles({
  body: { display: 'grid', gap: '14px', minWidth: 0 },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px', maxWidth: '75ch' },
  usage: { display: 'grid', gap: '8px', minWidth: 0 },
  name: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 700, overflowWrap: 'anywhere' },
  facts: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(132px, 100%), 1fr))' },
  bad: { color: h.emberT }, warning: { color: h.saffronT },
  scroll: { overflowX: 'auto', minWidth: 0 },
  external: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', '& svg': { flexShrink: 0 } },
  number: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
});

/** The period of a report as people say it: the month of a monthly report, else its first and last day. */
function period(report: SummaryReport, locale: string) {
  if (!report.periodStart) return '—';
  if (report.type === 'monthly_summary') {
    return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${report.periodStart}T00:00:00Z`));
  }

  return `${formatDate(report.periodStart)} – ${report.periodEnd ? formatDate(report.periodEnd) : '…'}`;
}

/**
 * The customer's security at a glance in the Drift tab (M41): what Huntress counts for the customer's Huntress organizations — the
 * agents it bills and among them those it calls unresponsive, outdated or isolated — and its monthly summary reports with a link to
 * the PDF in Huntress. Incidents, escalations and platform actions are alerts: they stand in the alert list above. A figure Huntress
 * did not give, or a read that never ran, is said as such, never as zero.
 */
export function SecurityPanel({ organizationId, scope }: { organizationId: string; scope: { owner: string; revision: number } }) {
  const { t, i18n } = useTranslation(); const styles = useStyles();
  const read = useSecurityOverview(organizationId, scope);
  const overview = read.isSuccess && !read.isFetching ? read.data : undefined;
  // Lists a read did not carry are empty, as the summary's reads are: nothing is claimed about them.
  const reads = overview?.reads ?? []; const usages = overview?.usage ?? []; const reports = overview?.reports ?? [];
  const organizationsRead = reads.find((r) => r.job === 'huntress-organizations');
  return <Panel title={t('security.panel.title')} icon={<Shield16Regular />}
    actions={reads.length > 0 && <AlertReadLine reads={reads} texts="service.readLine" label={(r) => t(`security.reads.${r.job}`, { system: sourceName(t, r.system) })} />}>
    <div className={styles.body}>
      <SavedServiceReadState checking={read.isFetching} error={read.error} onRetry={() => void read.refetch()} />
      {overview && usages.length === 0 && <Text block className={styles.muted}>
        {organizationsRead?.startedAt ? t('security.panel.notLinked') : t('security.panel.notRead')}</Text>}
      {usages.map((usage) => <UsageBlock key={`${usage.system}-${usage.externalOrganizationId}`} usage={usage} />)}
      {reports.length > 0 && <div className={styles.scroll} role="group" aria-label={t('security.reports.title')} tabIndex={0}>
        <Table aria-label={t('security.reports.title')} size="small" style={{ minWidth: 520 }}>
          <TableHeader><TableRow>
            <TableHeaderCell>{t('security.reports.period')}</TableHeaderCell>
            <TableHeaderCell>{t('security.reports.incidents')}</TableHeaderCell>
            <TableHeaderCell>{t('security.reports.signals')}</TableHeaderCell>
            <TableHeaderCell>{t('security.reports.agents')}</TableHeaderCell>
            <TableHeaderCell>{t('security.reports.pdf')}</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>{reports.map((report) => {
            const href = report.url ? safeHttpUrl(report.url) : undefined;
            const name = period(report, i18n.language);
            return <TableRow key={`${report.system}-${report.externalId}`}>
              <TableCell>{name}</TableCell>
              <TableCell className={styles.number}>{report.incidentsReported === null ? '—'
                : t('security.reports.incidentsValue', { reported: report.incidentsReported, resolved: report.incidentsResolved ?? 0 })}</TableCell>
              <TableCell className={styles.number}>{report.signalsDetected === null ? '—' : formatNumber(report.signalsDetected, 0)}</TableCell>
              <TableCell className={styles.number}>{report.agentsCount === null ? '—' : formatNumber(report.agentsCount, 0)}</TableCell>
              <TableCell>{href
                ? <Link href={href} target="_blank" rel="noopener noreferrer" className={styles.external}
                  aria-label={t('security.reports.openPdf', { period: name, source: sourceName(t, report.system) })}>
                  <DocumentPdf16Regular aria-hidden />{sourceName(t, report.system)}<Open16Regular aria-hidden /></Link>
                : '—'}</TableCell>
            </TableRow>;
          })}</TableBody>
        </Table>
      </div>}
      {overview && reports.length > 0 && overview.reportsTotal > reports.length && <Text block className={styles.muted}>
        {t('security.reports.shown', { shown: reports.length, total: overview.reportsTotal })}</Text>}
      {usages.length > 0 && reports.length === 0 && <Text block className={styles.muted}>{t('security.reports.none')}</Text>}
    </div>
  </Panel>;
}

function UsageBlock({ usage }: { usage: Usage }) {
  const { t } = useTranslation(); const styles = useStyles();
  const figure = (value: number | null, tone?: 'bad' | 'warning') =>
    value === null ? '—' : tone && value > 0 ? <span className={styles[tone]}>{formatNumber(value, 0)}</span> : formatNumber(value, 0);
  return <section className={styles.usage} aria-label={t('security.panel.usageOf', { name: usage.name })}>
    <h3 className={styles.name}>{t('security.panel.organization', { name: usage.name, source: sourceName(t, usage.system) })}</h3>
    <FigureGrid className={styles.facts} items={[
      { label: t('security.usage.billableAgents'), value: figure(usage.billableAgents),
        note: usage.agentsCount === null ? undefined : t('security.usage.allAgents', { count: usage.agentsCount }) },
      { label: t('security.usage.unresponsive'), value: figure(usage.unresponsiveAgents, 'warning') },
      { label: t('security.usage.outdated'), value: figure(usage.outdatedAgents, 'warning') },
      { label: t('security.usage.isolated'), value: figure(usage.isolatedAgents, 'bad') },
      ...(usage.billableIdentities !== null ? [{ label: t('security.usage.identities'), value: figure(usage.billableIdentities) }] : []),
      ...(usage.satLearners !== null ? [{ label: t('security.usage.learners'), value: figure(usage.satLearners) }] : []),
    ]} />
  </section>;
}
