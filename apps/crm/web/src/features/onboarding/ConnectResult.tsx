import { useEffect } from 'react';
import { Badge, Link, Spinner, Text, makeStyles } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { actionKeys } from '../actions/api';
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
  warn: { color: h.emberT },
  list: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '8px' },
  // A 24 px hit box for the way to a console (WCAG 2.5.8); the mark stays beside the words when they wrap.
  external: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', '& svg': { flexShrink: 0 } },
  link: { display: 'inline-flex', alignItems: 'center', minHeight: '24px' },
});

/** The outcome of one asked creation or a refused command, as the line under its vendor's name. */
export interface CreateOutcome {
  system: string;
  action: VendorAction | null;
  error: unknown;
}

/** A contract line the wizard added, could not add, or left out because its vendor's creation was refused (<c>skipped</c>). */
export interface LineOutcome {
  line: LineChoice;
  error: unknown;
  skipped: boolean;
}

/** The outcomes in which the vendor has the customer's record: what is left to do there is said, and the line has its service. */
const createdCodes = ['VND_CREATED', 'VND_CREATED_EARLIER', 'VND_CREATED_NOT_LINKED'];
const madeIt = (action: VendorAction | null | undefined) => action?.status === 'Succeeded' && createdCodes.includes(action.outcomeCode ?? '');

/**
 * The last step (M43): each creation followed until the worker has its outcome (the action log keeps it too), the contract lines added,
 * and what the vendors' APIs cannot do — named only for the vendors that now have the customer, with the way to the console where one
 * is configured. A line whose vendor was not created says so, so nobody bills a service that was never set up.
 */
export function ConnectResult({ creates, lines, contractId, contractNumber, choices, services, onSettled }: {
  creates: CreateOutcome[];
  lines: LineOutcome[];
  contractId: string | null;
  contractNumber: string | null;
  choices: CreateChoice[];
  services: CustomerService[];
  /** Called when the worker has an outcome for a creation: the card behind the wizard reads its links again. */
  onSettled: () => void;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  // Each creation is read again every two seconds while the worker has it, as the action dialog follows one.
  const live = useQueries({
    queries: creates.map((outcome) => ({
      queryKey: actionKeys.one(outcome.action?.id ?? ''),
      enabled: outcome.action !== null,
      initialData: outcome.action ?? undefined,
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await api.get<VendorAction>(`/api/v1/actions/${outcome.action!.id}`, signal)).data,
      refetchInterval: ({ state }: { state: { data?: VendorAction } }) => (state.data && isWaiting(state.data.status) ? 2_000 : false),
      staleTime: 0,
    })),
  });
  const actionOf = (system: string) => {
    const index = creates.findIndex((c) => c.system === system);
    return index < 0 ? undefined : live[index]?.data ?? creates[index]!.action;
  };
  const settledCount = creates.filter((c, i) => c.action !== null && !isWaiting((live[i]?.data ?? c.action!).status)).length;
  // The worker links the customer when it creates it, after the command returned: the links are read again as outcomes come in.
  useEffect(() => { if (settledCount > 0) onSettled(); }, [settledCount, onSettled]);

  const made = creates.filter((c) => madeIt(actionOf(c.system)));
  const waiting = creates.some((c) => c.action !== null && isWaiting(actionOf(c.system)!.status));
  return (
    <div className={styles.content}>
      {creates.length > 0 && (
        <section className={styles.section} aria-labelledby="connect-result-creates">
          <h3 id="connect-result-creates" className={styles.heading}>{t('onboarding.result.creates')}</h3>
          {creates.map((outcome) => <CreateLine key={outcome.system} outcome={outcome} live={actionOf(outcome.system) ?? null} />)}
        </section>
      )}
      {lines.length > 0 && contractNumber && (
        <section className={styles.section} aria-labelledby="connect-result-lines">
          <h3 id="connect-result-lines" className={styles.heading}>
            {contractId ? <AppLink to={`/contracts/${contractId}`} className={styles.link}>{t('onboarding.result.lines', { number: contractNumber })}</AppLink>
              : t('onboarding.result.lines', { number: contractNumber })}
          </h3>
          <ul className={styles.list}>
            {lines.map(({ line, error, skipped }) => {
              const product = line.product?.name ?? '—';
              const system = systemName(t, line.system);
              const vendor = actionOf(line.system);
              const notCreated = !skipped && error === null && vendor !== undefined && vendor !== null && !isWaiting(vendor.status) && !madeIt(vendor);
              return (
                <li key={line.system}>
                  {skipped ? t('onboarding.result.lineSkipped', { product, system })
                    : error !== null ? t('onboarding.result.lineFailed', { product, error: actionErrorText(t, error) })
                      : t('onboarding.result.lineAdded', { product })}
                  {notCreated && <Text block className={styles.warn}>{t('onboarding.result.lineWithoutService', { system })}</Text>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {made.length > 0 && (
        <section className={styles.section} aria-labelledby="connect-result-next">
          <h3 id="connect-result-next" className={styles.heading}>{t('onboarding.result.next')}</h3>
          <ul className={styles.list}>
            {made.map(({ system }) => {
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
      <Text block className={styles.muted}>
        {waiting ? t('onboarding.result.keepsGoing') : t('onboarding.result.logged')}{' '}
        <AppLink to="/connections" className={styles.link}>{t('onboarding.result.openLog')}</AppLink>
      </Text>
    </div>
  );
}

/** One creation: its status while the worker has it, then its outcome; announced as it changes. */
function CreateLine({ outcome, live }: { outcome: CreateOutcome; live: VendorAction | null }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const system = systemName(t, outcome.system);
  // A creation that ended without a record at the vendor says so in the badge; "Not allowed" would read as a refusal of access.
  const notCreated = live !== null && (live.status === 'Rejected' || live.status === 'Failed');
  return (
    <div className={styles.row} role="status" aria-live="polite">
      <Text className={styles.name}>{system}</Text>
      {live ? <>
        {notCreated ? <Badge appearance="tint" color={live.status === 'Failed' ? 'danger' : 'warning'}>{t('onboarding.result.notCreated')}</Badge>
          : <ActionStatusBadge status={live.status} />}
        {isWaiting(live.status) && <Spinner size="extra-tiny" aria-hidden />}
        <Text>{isWaiting(live.status) ? t('actions.dialog.sending', { system }) : outcomeText(t, live) || t(`actions.status.${live.status}`)}</Text>
      </> : <Text>{actionErrorText(t, outcome.error)}</Text>}
    </div>
  );
}
