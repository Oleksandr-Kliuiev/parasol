import { MessageBar, MessageBarBody, Spinner, Text, makeStyles } from '@fluentui/react-components';
import type { UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { formatDate } from '../../shared/utils/format';
import { actionErrorText, blockText, effectText } from '../actions/actionText';
import type { ActionPreview } from '../actions/types';
import { systemName } from '../integrations/labels';
import type { CreateChoice, LineChoice } from './connectServices';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '16px', gridTemplateColumns: 'minmax(0, 1fr)' },
  section: { display: 'grid', gap: '8px' },
  heading: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 600 },
  service: { display: 'grid', gap: '4px', paddingTop: '10px', borderTop: `1px solid ${h.line}`, ':first-of-type': { borderTop: 'none', paddingTop: 0 } },
  name: { fontWeight: 600 },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  effects: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '4px' },
});

/**
 * The third step (M43): what will happen, before anything is sent. Each creation shows the server's preview — made from saved data,
 * the same one the action confirmation shows — with what it creates and what blocks it; the contract lines are listed as they will be
 * added. Confirming sends them all at once.
 */
export function ConnectReview({ creates, previews, lines, contractNumber, from }: {
  creates: CreateChoice[];
  previews: UseQueryResult<ActionPreview>[];
  lines: LineChoice[];
  contractNumber: string | null;
  from: string;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const added = lines.filter((l) => l.add);
  return (
    <div className={styles.content}>
      {creates.length > 0 && (
        <section className={styles.section} aria-labelledby="connect-review-creates">
          <h3 id="connect-review-creates" className={styles.heading}>{t('onboarding.review.creates')}</h3>
          {creates.map((choice, index) => {
            const preview = previews[index];
            return (
              <div key={choice.system} className={styles.service}>
                <Text className={styles.name}>{systemName(t, choice.system)}</Text>
                {!preview || preview.isPending ? <Spinner size="extra-small" label={t('actions.dialog.previewing')} labelPosition="after" />
                  : preview.error ? (
                    <MessageBar intent="error" layout="multiline"><MessageBarBody>{actionErrorText(t, preview.error)}</MessageBarBody></MessageBar>
                  ) : preview.data && <>
                    <ul className={styles.effects} aria-label={t('actions.dialog.effects')}>
                      {preview.data.effects.map((effect, i) => <li key={`${effect.code}:${i}`}>{effectText(t, effect)}</li>)}
                    </ul>
                    {preview.data.block && <MessageBar intent="warning" layout="multiline"><MessageBarBody>{blockText(t, preview.data.block)}</MessageBarBody></MessageBar>}
                    {!preview.data.block && preview.data.simulated && <Text className={styles.muted}>{t('onboarding.simulated', { system: systemName(t, choice.system) })}</Text>}
                  </>}
              </div>
            );
          })}
        </section>
      )}
      {added.length > 0 && contractNumber && (
        <section className={styles.section} aria-labelledby="connect-review-lines">
          <h3 id="connect-review-lines" className={styles.heading}>{t('onboarding.review.lines', { number: contractNumber })}</h3>
          <ul className={styles.effects}>
            {added.map((line) => (
              <li key={line.system}>{t('onboarding.review.line', {
                product: line.product?.name ?? '—', model: t(`contracts.quantityModels.${line.model}`), quantity: line.estimate.trim(), date: formatDate(from),
              })}</li>
            ))}
          </ul>
        </section>
      )}
      {creates.length === 0 && added.length === 0 && <Text block>{t('onboarding.nothingChosen')}</Text>}
    </div>
  );
}
