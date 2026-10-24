import { Button, MessageBar, MessageBarActions, MessageBarBody, Spinner, Text, makeStyles } from '@fluentui/react-components';
import type { UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { formatDate } from '../../shared/utils/format';
import { actionErrorText, blockText, effectText } from '../actions/actionText';
import type { ActionPreview } from '../actions/types';
import { systemName } from '../integrations/labels';
import { mappingsOf, type CreateChoice, type LineChoice } from './connectServices';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '16px', gridTemplateColumns: 'minmax(0, 1fr)' },
  section: { display: 'grid', gap: '8px' },
  heading: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 600 },
  service: { display: 'grid', gap: '4px', paddingTop: '10px', borderTop: `1px solid ${h.line}`, ':first-of-type': { borderTop: 'none', paddingTop: 0 } },
  name: { fontWeight: 600 },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  effects: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '4px' },
  link: { display: 'inline-flex', alignItems: 'center', minHeight: '24px' },
});

/** Blocks a person fixes on the mapping screen: a record that is there already. */
const linkable = ['VND_EXISTS_AT_VENDOR', 'VND_AMBIGUOUS_AT_VENDOR'];

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
            const system = systemName(t, choice.system);
            const block = preview?.data?.block;
            // The preview comes after focus moved to the step's name: its outcome is announced, so a screen reader hears a block too.
            return (
              <div key={choice.system} className={styles.service} role="status" aria-live="polite">
                <Text className={styles.name}>{system}</Text>
                {!preview || preview.isPending ? <Spinner size="extra-small" label={t('actions.dialog.previewing')} labelPosition="after" />
                  : preview.error ? (
                    <MessageBar intent="error" layout="multiline">
                      <MessageBarBody>{actionErrorText(t, preview.error)}</MessageBarBody>
                      <MessageBarActions><Button size="small" onClick={() => void preview.refetch()}>{t('common.retry')}</Button></MessageBarActions>
                    </MessageBar>
                  ) : preview.data && <>
                    {preview.data.effects.length > 0 && (
                      <ul className={styles.effects} aria-label={t('onboarding.review.effects', { system })}>
                        {preview.data.effects.map((effect, i) => <li key={`${effect.code}:${i}`}>{effectText(t, effect)}</li>)}
                      </ul>
                    )}
                    {block && (
                      <MessageBar intent="warning" layout="multiline">
                        <MessageBarBody>
                          {t(`onboarding.review.blocks.${block.code}`, { system, defaultValue: blockText(t, block) })}
                          {linkable.includes(block.code) && mappingsOf[choice.system] && <>
                            {' '}<AppLink to={mappingsOf[choice.system]!} className={styles.link}>{t('onboarding.mapExisting')}</AppLink>
                          </>}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {!block && preview.data.simulated && <Text className={styles.muted}>{t('onboarding.simulated', { system })}</Text>}
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
