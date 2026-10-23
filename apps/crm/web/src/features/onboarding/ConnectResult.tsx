import { Link, Spinner, Text, makeStyles } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { useAction } from '../actions/api';
import { ActionStatusBadge } from '../actions/ActionStatusBadge';
import { actionErrorText, outcomeText } from '../actions/actionText';
import { isWaiting, type VendorAction } from '../actions/types';
import { systemName } from '../integrations/labels';
import type { CreateChoice, CustomerService, LineChoice } from './connectServices';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '16px', gridTemplateColumns: 'minmax(0, 1fr)' },
  section: { display: 'grid', gap: '8px' },
  heading: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 600 },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '10px', rowGap: '4px' },
  name: { fontWeight: 600, minWidth: '88px' },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  list: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '8px' },
  // A 24 px hit box for the way to a console (WCAG 2.5.8); the mark stays beside the words when they wrap.
  external: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', '& svg': { flexShrink: 0 } },
});

/** The outcome of one asked creation or a refused command, as the line under its vendor's name. */
export interface CreateOutcome {
  system: string;
  action: VendorAction | null;
  error: unknown;
}

export interface LineOutcome {
  line: LineChoice;
  error: unknown;
}

/**
 * The last step (M43): each creation followed until the worker has its outcome (the action log keeps it too), the contract lines added,
 * and what the vendors' APIs cannot do — named, with the way to the console where one is configured.
 */
export function ConnectResult({ creates, lines, contractNumber, choices, services }: {
  creates: CreateOutcome[];
  lines: LineOutcome[];
  contractNumber: string | null;
  choices: CreateChoice[];
  services: CustomerService[];
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  // What is left outside Parasoll for the vendors this wizard created the customer at.
  const created = creates.filter((c) => c.action !== null);
  return (
    <div className={styles.content}>
      {creates.length > 0 && (
        <section className={styles.section} aria-labelledby="connect-result-creates">
          <h3 id="connect-result-creates" className={styles.heading}>{t('onboarding.result.creates')}</h3>
          {creates.map((outcome) => <CreateLine key={outcome.system} outcome={outcome} />)}
        </section>
      )}
      {lines.length > 0 && contractNumber && (
        <section className={styles.section} aria-labelledby="connect-result-lines">
          <h3 id="connect-result-lines" className={styles.heading}>{t('onboarding.result.lines', { number: contractNumber })}</h3>
          <ul className={styles.list}>
            {lines.map(({ line, error }) => (
              <li key={line.system}>{error === null
                ? t('onboarding.result.lineAdded', { product: line.product?.name ?? '—' })
                : t('onboarding.result.lineFailed', { product: line.product?.name ?? '—', error: actionErrorText(t, error) })}</li>
            ))}
          </ul>
        </section>
      )}
      {created.length > 0 && (
        <section className={styles.section} aria-labelledby="connect-result-next">
          <h3 id="connect-result-next" className={styles.heading}>{t('onboarding.result.next')}</h3>
          <ul className={styles.list}>
            {created.map(({ system }) => {
              const url = services.find((s) => s.system === system)?.consoleUrl;
              const href = url ? safeHttpUrl(url) : undefined;
              const key = choices.find((c) => c.system === system)?.key ?? '';
              return (
                <li key={system}>
                  <Text>{t(`onboarding.result.steps.${system}`, { key })}</Text>{' '}
                  {href && (
                    <Link href={href} target="_blank" rel="noopener noreferrer" className={styles.external}>
                      <span>{t('onboarding.result.open', { system: systemName(t, system) })}</span><Open16Regular aria-hidden />
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <Text block className={styles.muted}>{t('onboarding.result.keepsGoing')}</Text>
    </div>
  );
}

/** One creation: its status while the worker has it, then its outcome; announced as it changes. */
function CreateLine({ outcome }: { outcome: CreateOutcome }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const live = useAction(outcome.action?.id ?? null, outcome.action ?? undefined).data ?? outcome.action;
  const system = systemName(t, outcome.system);
  return (
    <div className={styles.row} role="status" aria-live="polite">
      <Text className={styles.name}>{system}</Text>
      {live ? <>
        <ActionStatusBadge status={live.status} />
        {isWaiting(live.status) && <Spinner size="extra-tiny" aria-hidden />}
        <Text>{isWaiting(live.status) ? t('actions.dialog.sending', { system }) : outcomeText(t, live) || t(`actions.status.${live.status}`)}</Text>
      </> : <Text>{actionErrorText(t, outcome.error)}</Text>}
    </div>
  );
}
