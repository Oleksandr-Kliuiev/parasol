import { useState } from 'react';
import {
  Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, MessageBar, MessageBarBody, Spinner, Switch, Text,
  makeStyles,
} from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../../api/client';
import { h } from '../../../app/hearth';
import { Permissions, useCan } from '../../../auth/CurrentUserContext';
import { Dialog } from '../../../shared/components/Dialog';
import { useNotify } from '../../../shared/components/useNotify';
import { errorMessage } from '../../../shared/utils/errors';
import { formatDate } from '../../../shared/utils/format';
import type { CoverageRule } from '../types';
import { gapKey } from './alertText';
import { changeCoverageRule, coverageKeys, limitValue, useCoverageRules } from './coverageRules';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '16px', gridTemplateColumns: 'minmax(0, 1fr)' },
  rule: { display: 'grid', gap: '8px', minWidth: 0, paddingTop: '16px', borderTop: `1px solid ${h.line}` },
  name: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 700 },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  limit: { width: '120px' },
});

interface Draft { enabled: boolean; limit: string }

/**
 * Parasoll's own coverage checks (M40, M41), opened from the alert queue: each rule says what it watches, whether it raises alerts and
 * its limit (the days an agent may be silent, a machine may lack its second agent or an agent may stay behind). A change goes with the ETag of the rule as read; switching a rule off closes
 * its open alerts at once, and a new limit applies from the next check. A person who may only read sees the settings, unchangeable.
 */
export function CoverageRulesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(); const styles = useStyles(); const client = useQueryClient(); const notify = useNotify();
  const canWrite = useCan(Permissions.serviceWrite);
  const read = useCoverageRules();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const rules = read.data ?? [];
  const draft = (rule: CoverageRule): Draft => drafts[rule.code] ?? { enabled: rule.enabled, limit: rule.value === null ? '' : String(rule.value) };
  const setDraft = (rule: CoverageRule, next: Draft) => setDrafts((all) => ({ ...all, [rule.code]: next }));
  const limitOk = (rule: CoverageRule) => !rule.threshold || limitValue(draft(rule).limit, rule) !== null;
  const changed = rules.filter((rule) => {
    const d = draft(rule);
    return d.enabled !== rule.enabled || (rule.threshold !== null && d.limit.trim() !== String(rule.value));
  });

  const save = async () => {
    setTouched(true);
    if (changed.length === 0) { onClose(); return; }
    if (!changed.every(limitOk)) return;
    setBusy(true); setError(null);
    try {
      for (const rule of changed) {
        const d = draft(rule);
        await changeCoverageRule(rule, d.enabled, rule.threshold ? limitValue(d.limit, rule) : null);
      }
      // A rule switched off closed its open alerts: every list of alerts reads them again.
      void client.invalidateQueries({ queryKey: coverageKeys.rules });
      void client.invalidateQueries({ queryKey: ['service', 'alerts'] });
      notify(t('coverage.saved'));
      onClose();
    } catch (failure) {
      // Someone changed a rule in between: it is read again, and the person decides on what is there now.
      if (failure instanceof ApiError && failure.status === 412) { setError(t('coverage.conflict')); setDrafts({}); void read.refetch(); }
      else setError(errorMessage(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}>
    <DialogSurface><DialogBody>
      <DialogTitle>{t('coverage.title')}</DialogTitle>
      <DialogContent className={styles.content}>
        <Text block className={styles.muted}>{t('coverage.intro')}</Text>
        {!canWrite && <Text block className={styles.muted}>{t('coverage.readOnly')}</Text>}
        {read.isPending && <Spinner size="small" label={t('common.loading')} />}
        {read.isError && <MessageBar intent="error"><MessageBarBody>{errorMessage(read.error, t)}</MessageBarBody></MessageBar>}
        {rules.map((rule) => {
          const d = draft(rule); const key = gapKey(rule.code); const heading = `coverage-${rule.code}`;
          const range = rule.threshold && { min: rule.threshold.min, max: rule.threshold.max };
          return <section key={rule.code} className={styles.rule} aria-labelledby={heading}>
            <h3 id={heading} className={styles.name}>{key ? t(`coverage.rules.${key}.name`) : rule.code}</h3>
            {key && <Text block className={styles.muted}>{t(`coverage.rules.${key}.description`)} {t(`coverage.rules.${key}.when`)}</Text>}
            <Switch checked={d.enabled} disabled={!canWrite || busy} label={t('coverage.enabled')}
              onChange={(_, data) => setDraft(rule, { ...d, enabled: data.checked })} />
            {/* M41/M42: a rule whose limit is not a silence (the days a device may lack its second agent, a backup's age) names it itself. */}
            {rule.threshold && range && <Field label={key ? t(`coverage.rules.${key}.limit`, { defaultValue: t(`coverage.limit.${rule.threshold.unit}`) })
              : t(`coverage.limit.${rule.threshold.unit}`)} hint={t('coverage.limitHint', range)}
              validationMessage={touched && !limitOk(rule) ? t('coverage.limitInvalid', range) : undefined}>
              <Input className={styles.limit} type="number" inputMode="numeric" min={range.min} max={range.max} value={d.limit}
                disabled={!canWrite || busy} onChange={(_, data) => setDraft(rule, { ...d, limit: data.value })} />
            </Field>}
            {rule.enabled && !d.enabled && <Text block role="status" className={styles.muted}>{t('coverage.offNote')}</Text>}
            <Text block className={styles.muted}>
              {t('coverage.openGaps', { count: rule.openGaps })}{' · '}
              {rule.changedAt && rule.changedByName
                ? t('coverage.changed', { date: formatDate(rule.changedAt), name: rule.changedByName })
                : t('coverage.never')}
            </Text>
          </section>;
        })}
        {error && <MessageBar intent="warning"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      </DialogContent>
      <DialogActions>
        {canWrite
          ? <>
            <Button disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
            <Button appearance="primary" disabled={!read.data} disabledFocusable={busy} onClick={() => void save()}>
              {busy ? t('coverage.saving') : t('common.save')}</Button>
          </>
          : <Button appearance="primary" onClick={onClose}>{t('common.close')}</Button>}
      </DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}
