import { useNavigate } from 'react-router';
import {
  Button,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
} from '@fluentui/react-components';
import { Receipt16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Panel } from '../../shared/components/Panel';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { formatDate, formatDateTime } from '../../shared/utils/format';
import type { PrivacyCase } from './api';
import { recordLabel } from './recordLabel';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 },
  muted: { color: h.muted, fontSize: '13px' },
});

/** What a completed erasure did, per module; what it kept and why; and what is left for a person to erase by hand. */
export function ReceiptPanel({ privacyCase }: { privacyCase: PrivacyCase }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const navigate = useNavigate();
  const receipt = privacyCase.receipt!;
  const suppressions = receipt.suppressions.reduce((sum, s) => sum + s.count, 0);
  return (
    <Panel title={t('privacy.case.receipt.title')} icon={<Receipt16Regular />}>
      <div className={styles.stack}>
        <Text className={styles.muted}>{t('privacy.case.receipt.completed', { date: formatDateTime(privacyCase.completedAt) })}</Text>
        <ScrollTable>
          <Table size="small" aria-label={t('privacy.case.receipt.modules')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('privacy.case.plan.module')}</TableHeaderCell>
                <TableHeaderCell>{t('privacy.case.receipt.done')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipt.modules.map((m) => (
                <TableRow key={m.module}>
                  <TableCell>{t(`privacy.modules.${m.module}`, { defaultValue: m.module })}</TableCell>
                  <TableCell>{m.actions.map((a) => `${t(`privacy.case.actions.${a.action}`)}: ${a.records}`).join(' · ')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTable>
        {receipt.retained.length > 0 && (
          <ScrollTable>
            <Table size="small" aria-label={t('privacy.case.receipt.retained')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('privacy.case.receipt.retained')}</TableHeaderCell>
                  <TableHeaderCell>{t('privacy.case.plan.basis')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipt.retained.map((r) => (
                  <TableRow key={`${r.module}-${r.entityType}-${r.entityId}`}>
                    <TableCell>{recordLabel(t, r.module, r.entityType, r.entityId)}</TableCell>
                    <TableCell>
                      {r.basis && t(`privacy.case.bases.${r.basis}`)}
                      {r.until && <span className="tabular"> · {t('privacy.case.plan.until', { date: formatDate(r.until) })}</span>}
                      {r.note && <div className={styles.muted}>{r.note}</div>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollTable>
        )}
        {receipt.retained.some((r) => r.basis === 'LegalHold') && (
          // A hold keeps its record only until it ends; then a new request for the same person erases what it kept.
          <MessageBar intent="info">
            <MessageBarBody>{t('privacy.case.receipt.held')}</MessageBarBody>
            <MessageBarActions>
              <Button
                onClick={() =>
                  navigate(`/admin/privacy/new?subjectKind=${privacyCase.subjectKind}&subjectId=${privacyCase.subjectId}&kind=Erasure`, {
                    state: { subjectName: t('privacy.new.samePerson', { number: privacyCase.number }), back: `/admin/privacy/cases/${privacyCase.id}` },
                  })
                }
              >
                {t('privacy.case.receipt.eraseAgain')}
              </Button>
            </MessageBarActions>
          </MessageBar>
        )}
        {suppressions > 0 && <Text>{t('privacy.case.receipt.suppressions', { count: suppressions })}</Text>}
        {receipt.operatorErasure.length > 0 && (
          <MessageBar intent="info">
            <MessageBarBody>{t('privacy.case.receipt.operator')}</MessageBarBody>
          </MessageBar>
        )}
        {receipt.externalSystems.length > 0 && (
          <MessageBar intent="warning">
            <MessageBarBody>{t('privacy.case.receipt.external', { systems: receipt.externalSystems.map((s) => t(`systems.${s}`, { defaultValue: s })).join(', ') })}</MessageBarBody>
          </MessageBar>
        )}
      </div>
    </Panel>
  );
}
