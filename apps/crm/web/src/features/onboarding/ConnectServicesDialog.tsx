import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, MessageBar, MessageBarActions, MessageBarBody, Spinner, Text, makeStyles,
  mergeClasses, tokens,
} from '@fluentui/react-components';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { h } from '../../app/hearth';
import { Dialog } from '../../shared/components/Dialog';
import { ErrorState } from '../../shared/components/ErrorState';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
import { previewAction, requestAction, useRefreshActions } from '../actions/api';
import type { ActionPreview } from '../actions/types';
import { serviceQuantityKeys, useServiceQuantities } from '../billing/serviceQuantities';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { contractKeys, contractQuery, useContracts } from '../contracts/api';
import type { LineRequest } from '../contracts/types';
import { dayIn } from '../service/alerts/alertHiding';
import { ConnectResult, type CreateOutcome, type LineOutcome } from './ConnectResult';
import { ConnectReview } from './ConnectReview';
import { ContractLinesStep } from './ContractLinesStep';
import {
  choiceValid, createRequest, initialChoice, lineStart, lineValid, modelOf, onboardingKeys, openContract, useCustomerServices, withContract,
  type BilledLine, type CreateChoice, type LineChoice,
} from './connectServices';
import { ServiceChoices } from './ServiceChoices';

type Step = 'services' | 'contract' | 'review' | 'result';

const steps: Step[] = ['services', 'contract', 'review', 'result'];

/** A preview's token lives ten minutes: a wizard left open on its confirmation reads the previews again well before that. */
const PreviewRefresh = 4 * 60_000;

const useStyles = makeStyles({
  content: { display: 'grid', gap: '14px', gridTemplateColumns: 'minmax(0, 1fr)' },
  scroll: { ':focus-visible': { outlineWidth: '2px', outlineStyle: 'solid', outlineColor: tokens.colorStrokeFocus2, outlineOffset: '2px' } },
  step: { color: h.muted, fontSize: '13px', lineHeight: '20px', fontWeight: 600, ':focus': { outlineStyle: 'none' } },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
});

/**
 * "Connect services" (M43): the customer is created in Atera, Huntress and CloudAlly — each on the vendor action path, previewed from
 * saved data and linked at once by the worker — and the services go into the customer's contract as lines billed by what the service
 * counts. Four steps: what to create, the contract lines, the preview of everything, and the outcome with what is left to do in the
 * vendors' consoles. Closing it never stops what was asked: the action log keeps the outcome.
 */
export function ConnectServicesDialog({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const client = useQueryClient();
  const refreshActions = useRefreshActions();
  const canBilling = useCan(Permissions.billingRead);
  const services = useCustomerServices(organizationId);
  const contracts = useContracts({ organizationId });
  const quantities = useServiceQuantities(organizationId, canBilling);
  const [step, setStep] = useState<Step>('services');
  const [touched, setTouched] = useState(false);
  // What the person changed; until then the server's defaults and the contract's own start stand.
  const [edited, setEdited] = useState<CreateChoice[] | null>(null);
  const [chosenLines, setLines] = useState<LineChoice[]>([]);
  const [pickedContract, setPickedContract] = useState<string | null>(null);
  const [pickedFrom, setPickedFrom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creates, setCreates] = useState<CreateOutcome[]>([]);
  const [lineOutcomes, setLineOutcomes] = useState<LineOutcome[]>([]);
  // One key per vendor for this opening: a repeat after a lost answer returns the action already saved, never a second one.
  const commandKeys = useRef(new Map<string, string>());
  const stepRef = useRef<HTMLParagraphElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(contentRef, 'y', step);

  const list = useMemo(() => services.data?.services ?? [], [services.data]);
  const choices = useMemo(() => edited ?? (services.data ? services.data.services.map(initialChoice) : null), [edited, services.data]);
  const open = (contracts.data?.pages.flatMap((p) => p.items) ?? []).filter(openContract);
  const contractId = pickedContract ?? (open.find((c) => c.status === 'Active') ?? open[0])?.id ?? null;
  // Every open contract's lines: a service one of them bills already must not get a second line in another (the collector bills both).
  const details = useQueries({ queries: open.map((c) => contractQuery(c.id)) });
  const contract = details.find((d) => d.data?.data.id === contractId)?.data?.data;
  const billed = details.flatMap((d) => {
    const c = d.data?.data;
    return c ? c.lines.map((l): BilledLine => ({ contractId: c.id, contractNumber: c.number, quantityModel: l.quantityModel, validTo: l.validTo })) : [];
  });
  const minFrom = contract?.startDate ?? null;
  const from = pickedFrom ?? (contract ? lineStart(contract, dayIn(0)) : dayIn(0));
  const lines = withContract(chosenLines, billed, from);
  // Each step announces itself: focus goes to its name, so a screen reader hears where it is and Tab goes on from there.
  useEffect(() => { stepRef.current?.focus(); }, [step]);

  const chosen = (choices ?? []).filter((c) => c.create);
  const requests = useMemo(
    () => (step === 'review' ? (choices ?? []).filter((c) => c.create).map((c) => createRequest(c, organizationId)) : []),
    [step, choices, organizationId]);
  const previews = useQueries({
    queries: requests.map((request) => ({
      queryKey: ['onboarding', 'preview', request] as const,
      queryFn: () => previewAction(request),
      retry: false, staleTime: PreviewRefresh, refetchInterval: PreviewRefresh, gcTime: 0, refetchOnWindowFocus: false,
    })),
  });

  /** The lines the contract step offers: one per vendor the customer has or gets, kept as the person left them. */
  const linesFor = (current: CreateChoice[], kept: LineChoice[] = chosenLines) => list
    .filter((s) => modelOf[s.system] && (s.link !== null || current.some((c) => c.system === s.system && c.create)))
    .map((s) => kept.find((l) => l.system === s.system) ?? {
      system: s.system, model: modelOf[s.system]!, add: true, product: null,
      estimate: String(quantities.data?.services.find((q) => q.model === modelOf[s.system])?.count ?? 0),
    });

  const go = (next: Step) => { setTouched(false); setStep(next); };
  /** After a Continue the fields refused, focus goes to the first field that says why (WCAG 3.3.1). */
  const showFirstError = () => requestAnimationFrame(() => contentRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  const forward = () => {
    setTouched(true);
    if (step === 'services') {
      if (!(choices ?? []).every(choiceValid)) {
        showFirstError();
        return;
      }
      setLines(linesFor(choices ?? []));
      go('contract');
    } else if (step === 'contract') {
      if (open.length > 0 && (!lines.every(lineValid) || (minFrom !== null && lines.some((l) => l.add) && from < minFrom))) {
        showFirstError();
        return;
      }
      go('review');
    }
  };
  /** The customer's links, services and counts, read again when something was asked and again when the worker linked it. */
  const refreshCustomer = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['integrations', 'links'] });
    void client.invalidateQueries({ queryKey: onboardingKeys.services(organizationId) });
    void client.invalidateQueries({ queryKey: serviceQuantityKeys.one(organizationId) });
  }, [client, organizationId]);
  const addedLines = open.length > 0 && contractId ? lines.filter((l) => l.add) : [];
  const previewsReady = previews.every((p) => p.data && p.data.block === null && p.data.previewToken !== null);
  const anyBlocked = previews.some((p) => p.data?.block || p.error);
  const canConfirm = !busy && (requests.length > 0 || addedLines.length > 0) && previewsReady;

  const confirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    const outcomes: CreateOutcome[] = [];
    for (const [index, request] of requests.entries()) {
      const preview = previews[index]?.data as ActionPreview;
      const key = commandKeys.current.get(request.system) ?? crypto.randomUUID();
      commandKeys.current.set(request.system, key);
      try {
        outcomes.push({ system: request.system, action: await requestAction(preview, request, key, {}), error: null });
      } catch (error) {
        outcomes.push({ system: request.system, action: null, error });
      }
    }

    // A line is added for a service the customer has, or one whose creation was taken; a refused request adds no line for it.
    const added: LineOutcome[] = [];
    for (const line of addedLines) {
      const refused = outcomes.find((o) => o.system === line.system && o.action === null);
      if (refused) {
        added.push({ line, error: refused.error, skipped: true });
        continue;
      }
      const body: LineRequest = {
        productId: line.product!.id, description: null, quantityModel: line.model, deviceFilter: line.model === 'PerAteraDevice' ? 'All' : null,
        quantity: Number(line.estimate.trim()), unitPrice: null, discountPct: null, validFrom: from, validTo: null,
      };
      try {
        await api.post(`/api/v1/contracts/${contractId}/lines`, body);
        added.push({ line, error: null, skipped: false });
      } catch (error) {
        added.push({ line, error, skipped: false });
      }
    }

    setCreates(outcomes);
    setLineOutcomes(added);
    refreshActions();
    refreshCustomer();
    void client.invalidateQueries({ queryKey: contractKeys.all });
    setBusy(false);
    go('result');
  };

  const position = steps.indexOf(step) + 1;
  const contractNumber = contract?.number ?? null;
  return (
    // Closing while the requests go out would hide their outcome: Escape and a click beside it wait until they are sent.
    <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('onboarding.title')}</DialogTitle>
          <DialogContent ref={contentRef} className={mergeClasses(styles.content, styles.scroll)} style={edges.style}
            role={edges.overflow ? 'region' : undefined} aria-label={edges.overflow ? t('onboarding.title') : undefined} tabIndex={edges.overflow ? 0 : undefined}>
            <Text as="p" ref={stepRef} tabIndex={-1} className={styles.step}>
              {t('onboarding.step', { current: position, total: steps.length, name: t(`onboarding.steps.${step}`) })}
            </Text>
            {step === 'services' && (services.isPending ? <Spinner size="small" label={t('onboarding.loading')} />
              : services.error ? <ErrorState error={services.error} onRetry={() => void services.refetch()} />
                : list.length === 0 ? <Text block>{t('onboarding.noneEnabled')}</Text>
                  : <>
                    <Text block className={styles.muted}>{t('onboarding.intro', { customer: services.data?.name ?? '' })}</Text>
                    {choices && <ServiceChoices services={list} choices={choices} touched={touched}
                      onChange={(choice) => setEdited(choices.map((c) => (c.system === choice.system ? choice : c)))} />}
                  </>)}
            {step === 'contract' && (
              <ContractLinesStep contracts={open} loading={contracts.isPending} error={contracts.error} onRetry={() => void contracts.refetch()}
                contractId={contractId} onContract={(id) => { setPickedContract(id); setPickedFrom(null); setLines(linesFor(choices ?? [], [])); }}
                lines={lines} billed={billed} from={from} onFrom={setPickedFrom} minFrom={minFrom} touched={touched}
                onLine={(line) => setLines((current) => current.map((l) => (l.system === line.system ? line : l)))} />
            )}
            {step === 'review' && (
              <>
                <ConnectReview creates={chosen} previews={previews} lines={addedLines} contractNumber={contractNumber} from={from} />
                {anyBlocked && (
                  <MessageBar intent="warning" layout="multiline">
                    <MessageBarBody>{t('onboarding.review.blocked')}</MessageBarBody>
                    <MessageBarActions>
                      <Button size="small" onClick={() => go('services')}>{t('onboarding.review.backToServices')}</Button>
                    </MessageBarActions>
                  </MessageBar>
                )}
              </>
            )}
            {step === 'result' && (
              <ConnectResult creates={creates} lines={lineOutcomes} contractId={contractId} contractNumber={contractNumber} choices={choices ?? []}
                services={list} onSettled={refreshCustomer} />
            )}
          </DialogContent>
          <DialogActions>
            {step === 'result' ? (
              <Button appearance="primary" onClick={onClose}>{t('common.close')}</Button>
            ) : <>
              {step !== 'services' && <Button onClick={() => go(step === 'review' ? 'contract' : 'services')} disabled={busy}>{t('common.back')}</Button>}
              <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
              {step === 'review' ? (
                <Button appearance="primary" onClick={() => void confirm()} disabled={!canConfirm}>
                  {busy ? t('onboarding.busy') : requests.length > 0 ? t('onboarding.confirm') : t('onboarding.confirmLinesOnly')}
                </Button>
              ) : (
                <Button appearance="primary" onClick={forward} disabled={step === 'services' && (services.isPending || list.length === 0)}>
                  {t('onboarding.continue')}
                </Button>
              )}
            </>}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
