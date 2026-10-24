import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Button,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Option,
  Spinner,
  Text,
  Textarea,
  makeStyles,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { ArrowDownload20Regular, DocumentBulletList16Regular, Money16Regular, Send20Regular, TextAlignLeft16Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan, useCurrentUser } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, formatDate, formatMoney, parseDecimal } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { OrganizationPicker } from '../contracts/OrganizationPicker';
import { useOrganizationContacts, useQuote, useQuoteActions, useQuoteTemplates, quotePdfUrl } from './api';
import { QuoteLinesEditor, QuoteLinesTable } from './QuoteLines';
import { emptyLine, lineAmount, toDraft, type LineDraft, pricedOnSave } from './lineDraft';
import { QuoteStatusBadge } from './shared';
import type { Quote, QuoteRequest } from './types';
import { ReasonDialog, SendQuoteDialog, TransferQuoteDialog } from './QuoteDialogs';
import { QuoteHistoryPanel } from './QuoteHistoryPanel';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: '16px', alignItems: 'start' },
  editGrid: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)',
    gap: '16px',
    alignItems: 'start',
    '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' },
  },
  side: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 },
  contents: { display: 'contents' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: '14px 16px', alignItems: 'start', '& .fui-Dropdown, & .fui-Combobox': { minWidth: 0 } },
  wide: { gridColumn: '1 / -1' },
  // The monthly sum as the reference's "estimated payment" block: a soft ember well, the figure in display type.
  well: { display: 'grid', gap: '4px', marginBottom: '14px', paddingTop: '14px', paddingBottom: '14px', paddingLeft: '16px', paddingRight: '16px', borderRadius: '14px', backgroundColor: h.emberSoft },
  total: { fontFamily: h.display, fontSize: 'clamp(26px, 2.4vw, 34px)', lineHeight: 1.1, fontWeight: 600, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' },
  muted: { color: h.muted, fontSize: '12px' },
  texts: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '75ch' },
  text: { display: 'grid', gap: '4px', whiteSpace: 'pre-wrap' },
  textLabel: { color: h.muted, fontSize: '12px', fontWeight: 700, lineHeight: '16px' },
  message: { marginBottom: '12px' },
});

interface FormState {
  organization: { id: string; name: string } | null;
  contactId: string;
  title: string;
  ownerId: string | null;
  ownerName: string | null;
  language: string;
  validUntil: string;
  termMonths: string;
  templateId: string;
  introText: string;
  termsText: string;
  customerReference: string;
  lines: LineDraft[];
}

function emptyForm(organization: { id: string; name: string } | null): FormState {
  return {
    organization,
    contactId: '',
    title: '',
    ownerId: null,
    ownerName: null,
    language: 'nb',
    validUntil: '',
    termMonths: '12',
    templateId: '',
    introText: '',
    termsText: '',
    customerReference: '',
    lines: [emptyLine()],
  };
}

function formOf(quote: Quote): FormState {
  return {
    organization: { id: quote.organization.id, name: quote.organization.name },
    contactId: quote.contactId ?? '',
    title: quote.title,
    ownerId: quote.owner?.id ?? null,
    ownerName: quote.owner?.name ?? null,
    language: quote.language,
    validUntil: quote.validUntil,
    termMonths: String(quote.termMonths),
    templateId: '',
    introText: quote.introText ?? '',
    termsText: quote.termsText ?? '',
    customerReference: quote.customerReference ?? '',
    lines: quote.lines.map(toDraft),
  };
}

function requestOf(form: FormState, opportunityId: string | null): QuoteRequest {
  return {
    organizationId: form.organization?.id ?? '',
    contactId: form.contactId === '' ? null : form.contactId,
    opportunityId,
    title: form.title.trim(),
    ownerId: form.ownerId,
    language: form.language,
    validUntil: form.validUntil === '' ? null : form.validUntil,
    termMonths: Number(form.termMonths) || 0,
    templateId: form.templateId === '' ? null : form.templateId,
    introText: blankToNull(form.introText),
    termsText: blankToNull(form.termsText),
    customerReference: blankToNull(form.customerReference),
    lines: form.lines
      .filter((line) => line.name.trim() !== '' || line.productId)
      .map((line) => ({
        productId: line.productId,
        sku: line.sku,
        name: line.name.trim() || line.product?.name || '',
        description: blankToNull(line.description),
        quantity: parseDecimal(line.quantity) ?? 0,
        unitPrice: line.unitPrice.trim() === '' ? null : (parseDecimal(line.unitPrice) ?? 0),
        discountPct: parseDecimal(line.discountPct) ?? 0,
        recurrence: line.recurrence,
        vatRate: line.vatRate,
      })),
  };
}

/** Loads the quote, then hands it to the editor keyed by version, so the form starts from the version it edits. */
export function QuotePage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { data: quote, error, isPending, refetch } = useQuote(id);

  if (id !== undefined && isPending) return <Spinner label={t('common.loading')} />;
  if (error instanceof ApiError && error.status === 404) return <NotFoundPage />;
  if (id !== undefined && (error || !quote)) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return <QuoteEditor key={quote?.id ?? 'new'} quote={quote ?? null} />;
}

function QuoteEditor({ quote }: { quote: Quote | null }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const notify = useNotify();
  const canWrite = useCan(Permissions.salesWrite);
  const canApproveDiscount = useCan(Permissions.salesDiscountApprove);
  const canSeeMoney = useCan(Permissions.financeRead);
  const user = useCurrentUser();
  // DEV-09: limited to the quotes they own, a user keeps them their own; handing one over is the transfer below.
  const ownQuotesOnly = !user.recordScope.allQuotes;
  const isNew = quote === null;
  const isCurrentVersion = quote !== null && quote.versions.every((version) => version.versionNo <= quote.versionNo);
  const actions = useQuoteActions(quote?.id);
  const templates = useQuoteTemplates();
  const [form, setForm] = useState<FormState>(() =>
    quote
      ? formOf(quote)
      : emptyForm(params.get('organizationId') ? { id: params.get('organizationId')!, name: params.get('organizationName') ?? '' } : null),
  );
  const [dialog, setDialog] = useState<'send' | 'reject' | 'decline' | 'transfer' | null>(null);
  const contacts = useOrganizationContacts(form.organization?.id);
  const restoreFocusTarget = useRestoreFocusTarget();

  const editable = canWrite && (isNew || Boolean(quote?.isEditable));
  // DEV-08: a released version cannot be downloaded or sent until its document is stored.
  const documentPreparing = quote?.documents.at(-1)?.status === 'Preparing';
  const monthly = form.lines.filter((line) => line.recurrence === 'Monthly').reduce((sum, line) => sum + lineAmount(line), 0);
  const oneTime = form.lines.filter((line) => line.recurrence === 'OneTime').reduce((sum, line) => sum + lineAmount(line), 0);
  const term = Number(form.termMonths) || 0;
  // Lines the price list prices on saving are not in the sums yet: the figures say so instead of counting them as zero.
  const unpriced = form.lines.filter(pricedOnSave).length;

  const run = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      notify(label);
      return true;
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
      return false;
    }
  };

  const save = async () => {
    if (!form.organization || form.title.trim() === '') {
      notify(t('quotes.missingFields'), 'warning');
      return;
    }

    if (isNew) {
      try {
        const { data } = await actions.create.mutateAsync(requestOf(form, params.get('opportunityId')));
        notify(t('quotes.created'));
        navigate(`/quotes/${data.id}`, { replace: true });
      } catch (e) {
        notify(t('errors.generic'), 'error', errorMessage(e, t));
      }
      return;
    }

    await run(t('quotes.saved'), () =>
      actions.update.mutateAsync({ request: requestOf(form, quote!.opportunityId), etag: quote!.etag }),
    );
  };

  const transfer = async (owner: { id: string; displayName: string }) => {
    try {
      await actions.transfer.mutateAsync({ ownerId: owner.id, etag: quote!.etag });
      notify(t('quotes.transfer.done', { name: owner.displayName }));
      setDialog(null);
      // A user limited to their own quotes no longer sees this one: back to the list rather than a page that is gone.
      if (ownQuotesOnly && owner.id !== user.id) navigate('/quotes', { replace: true });
      await actions.refresh();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  const revise = async () => {
    try {
      const { data } = await actions.revise.mutateAsync();
      notify(t('quotes.revised', { version: data.versionNo }));
      navigate(`/quotes/${data.id}`);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <>
      <PageHeader
        back={{ to: '/quotes', label: t('quotes.title') }}
        title={isNew ? t('quotes.new') : `${quote!.number}${quote!.versionNo > 1 ? ` · v${quote!.versionNo}` : ''}`}
        subtitle={isNew ? undefined : quote!.title}
        meta={
          !isNew && (
            <>
              <QuoteStatusBadge status={quote!.status} />
              <AppLink to={`/organizations/${quote!.organization.id}`}>{quote!.organization.name}</AppLink>
              {quote!.opportunityId && (
                <AppLink to={`/sales/opportunities/${quote!.opportunityId}`}>{quote!.opportunityName ?? t('quotes.openDeal')}</AppLink>
              )}
              <Text className={styles.muted}>{t('quotes.validUntilOn', { date: formatDate(quote!.validUntil) })}</Text>
            </>
          )
        }
        actions={
          <>
            {/* Releasing is a draft's step; a version already released is sent or revised, not released again. */}
            {!isNew && editable && quote!.status === 'Draft' && quote!.lines.length > 0 && (
              <Button onClick={() => void run(t('quotes.submitted'), () => actions.submit.mutateAsync())}>{t('quotes.submit')}</Button>
            )}
            {!isNew && quote!.status === 'PendingApproval' && canApproveDiscount && (
              <Button {...restoreFocusTarget} onClick={() => setDialog('reject')}>
                {t('quotes.reject')}
              </Button>
            )}
            {!isNew && quote!.status === 'PendingApproval' && canWrite && (
              <Button appearance="subtle" onClick={() => void run(t('quotes.withdrawn'), () => actions.withdraw.mutateAsync())}>
                {t('quotes.withdraw')}
              </Button>
            )}
            {!isNew && quote!.hasDocument && canSeeMoney && !documentPreparing && (
              <Button icon={<ArrowDownload20Regular />} as="a" href={quotePdfUrl(quote!.id)} target="_blank" rel="noopener noreferrer">
                {t('quotes.downloadPdf')}
              </Button>
            )}
            {!isNew && canWrite && (quote!.status === 'Ready' || quote!.status === 'Sent') && (
              <>
                {/* With e-mail switched off the server refuses to send: the button is off and the banner below says why. */}
                <Button {...restoreFocusTarget} icon={<Send20Regular />} disabled={documentPreparing || !quote!.canSendByEmail}
                  disabledFocusable={!quote!.canSendByEmail} onClick={() => setDialog('send')}>
                  {t('quotes.send')}
                </Button>
                <Button {...restoreFocusTarget} onClick={() => setDialog('decline')}>
                  {t('quotes.decline')}
                </Button>
              </>
            )}
            {!isNew && canWrite && quote!.status !== 'Accepted' && quote!.status !== 'Superseded' && quote!.status !== 'Draft' && (
              <Button appearance="subtle" onClick={() => void revise()}>
                {t('quotes.revise')}
              </Button>
            )}
            {!isNew && canWrite && isCurrentVersion && (
              <Button {...restoreFocusTarget} appearance="subtle" onClick={() => setDialog('transfer')}>
                {t('quotes.transfer.action')}
              </Button>
            )}
            {/* The page's one primary action comes last: save a draft, approve a discount or record the customer's yes. A
                released version can still be edited, but saving it is then the quieter step (it returns it to draft). */}
            {editable && (
              <Button appearance={isNew || quote!.status === 'Draft' ? 'primary' : 'secondary'} disabled={actions.create.isPending || actions.update.isPending} onClick={() => void save()}>
                {isNew ? t('quotes.create') : t('common.save')}
              </Button>
            )}
            {!isNew && quote!.status === 'PendingApproval' && canApproveDiscount && (
              <Button appearance="primary" onClick={() => void run(t('quotes.approved'), () => actions.approve.mutateAsync())}>
                  {t('quotes.approve')}
                </Button>
            )}
            {!isNew && canWrite && (quote!.status === 'Ready' || quote!.status === 'Sent') && (
                <Button appearance="primary" onClick={() => void run(t('quotes.accepted'), () => actions.accept.mutateAsync())}>
                  {t('quotes.accept')}
                </Button>
            )}
          </>
        }
      />

      {!isNew && documentPreparing && (
        <MessageBar intent="info" className={styles.message}>
          <MessageBarBody>{t('quotes.document.preparingBody')}</MessageBarBody>
        </MessageBar>
      )}
      {!isNew && quote!.status === 'PendingApproval' && (
        <MessageBar intent="warning" className={styles.message}>
          <MessageBarBody>
            {t('quotes.awaitingApprovalBody', { pct: quote!.maxDiscountPct, limit: quote!.discountLimitPct })}
          </MessageBarBody>
        </MessageBar>
      )}
      {!isNew && quote!.rejectedReason && quote!.status === 'Draft' && (
        <MessageBar intent="error" className={styles.message}>
          <MessageBarBody>{t('quotes.rejectedBody', { reason: quote!.rejectedReason })}</MessageBarBody>
        </MessageBar>
      )}
      {!isNew && quote!.status === 'Accepted' && (
        <MessageBar intent="success" className={styles.message}>
          <MessageBarBody>{t('quotes.acceptedBody', { date: formatDate(quote!.decidedOn) })}</MessageBarBody>
          <MessageBarActions>
            <AppLink to={`/contracts?search=${encodeURIComponent(quote!.title)}`}>{t('quotes.openDraftContract')}</AppLink>
          </MessageBarActions>
        </MessageBar>
      )}
      {!isNew && editable && quote!.status !== 'Draft' && (
        <MessageBar intent="info" className={styles.message}>
          <MessageBarBody>{t('quotes.editReturnsToDraft')}</MessageBarBody>
        </MessageBar>
      )}
      {!isNew && (quote!.status === 'Ready' || quote!.status === 'Sent') && !quote!.canSendByEmail && (
        <MessageBar intent="info" className={styles.message}>
          <MessageBarBody>{t('quotes.emailDisabled')}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.stack}>
        <div className={editable ? styles.editGrid : styles.grid}>
          <Panel title={t('quotes.sections.quote')} icon={<DocumentBulletList16Regular />}>
            {editable ? (
              <div className={styles.formGrid}>
                <Field label={t('quotes.fields.organization')} required className={styles.wide}>
                  <OrganizationPicker
                    value={form.organization}
                    disabled={!isNew}
                    onChange={(value) => setForm({ ...form, organization: value, contactId: '' })}
                  />
                </Field>
                <Field label={t('quotes.fields.title')} required className={styles.wide}>
                  <Input value={form.title} onChange={(_, d) => setForm({ ...form, title: d.value })} />
                </Field>
                <Field label={t('quotes.fields.contact')}>
                  <Dropdown
                    disabled={!form.organization}
                    selectedOptions={[form.contactId]}
                    value={
                      (contacts.data ?? []).find((c) => c.id === form.contactId)
                        ? `${(contacts.data ?? []).find((c) => c.id === form.contactId)!.firstName} ${(contacts.data ?? []).find((c) => c.id === form.contactId)!.lastName}`
                        : (quote?.contactName || t('common.none'))
                    }
                    onOptionSelect={(_, d) => setForm({ ...form, contactId: d.optionValue ?? '' })}
                  >
                    <Option value="">{t('common.none')}</Option>
                    {(contacts.data ?? []).map((contact) => (
                      <Option key={contact.id} value={contact.id}>
                        {`${contact.firstName} ${contact.lastName}${contact.email ? ` · ${contact.email}` : ''}`}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                {ownQuotesOnly ? (
                  <Field label={t('quotes.fields.owner')} hint={t('quotes.ownerLocked')}>
                    <Text>{form.ownerName ?? user.displayName}</Text>
                  </Field>
                ) : (
                  <Field label={t('quotes.fields.owner')}>
                    <UserPicker
                      value={form.ownerId ? { id: form.ownerId, displayName: form.ownerName ?? '' } : null}
                      onChange={(picked) => setForm({ ...form, ownerId: picked?.id ?? null, ownerName: picked?.displayName ?? null })}
                    />
                  </Field>
                )}
                <Field label={t('quotes.fields.validUntil')}>
                  <Input type="date" value={form.validUntil} onChange={(_, d) => setForm({ ...form, validUntil: d.value })} />
                </Field>
                <Field label={t('quotes.fields.termMonths')} hint={t('quotes.termHint')}>
                  <Input
                    type="number"
                    min={0}
                    max={120}
                    value={form.termMonths}
                    onChange={(_, d) => setForm({ ...form, termMonths: d.value })}
                  />
                </Field>
                <Field label={t('quotes.fields.language')}>
                  <Dropdown
                    selectedOptions={[form.language]}
                    value={t(`quotes.languages.${form.language}`)}
                    onOptionSelect={(_, d) => setForm({ ...form, language: d.optionValue ?? 'nb' })}
                  >
                    <Option value="nb">{t('quotes.languages.nb')}</Option>
                    <Option value="en">{t('quotes.languages.en')}</Option>
                  </Dropdown>
                </Field>
                <Field label={t('quotes.fields.customerReference')}>
                  <Input
                    value={form.customerReference}
                    onChange={(_, d) => setForm({ ...form, customerReference: d.value })}
                  />
                </Field>
                {isNew && (
                  <Field label={t('quotes.fields.template')} hint={t('quotes.templateHint')} className={styles.wide}>
                    <Dropdown
                      selectedOptions={[form.templateId]}
                      value={(templates.data ?? []).find((template) => template.id === form.templateId)?.name ?? t('quotes.defaultTemplate')}
                      onOptionSelect={(_, d) => {
                        const template = (templates.data ?? []).find((item) => item.id === d.optionValue);
                        setForm({
                          ...form,
                          templateId: d.optionValue ?? '',
                          language: template?.language ?? form.language,
                          introText: template?.introText ?? form.introText,
                          termsText: template?.termsText ?? form.termsText,
                        });
                      }}
                    >
                      <Option value="">{t('quotes.defaultTemplate')}</Option>
                      {(templates.data ?? []).map((template) => (
                        <Option key={template.id} value={template.id}>
                          {template.name}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                )}
                </div>
            ) : (
              <DetailList
                items={[
                  { label: t('quotes.fields.organization'), value: quote!.organization.name },
                  { label: t('quotes.fields.title'), value: quote!.title },
                  { label: t('quotes.fields.contact'), value: quote!.contactName },
                  { label: t('quotes.fields.owner'), value: quote!.owner?.name },
                  { label: t('quotes.fields.validUntil'), value: formatDate(quote!.validUntil) },
                  { label: t('quotes.fields.termMonths'), value: String(quote!.termMonths) },
                  { label: t('quotes.fields.language'), value: t(`quotes.languages.${quote!.language}`) },
                  { label: t('quotes.fields.customerReference'), value: quote!.customerReference },
                ]}
              />
            )}
          </Panel>

          {/* While the quote is edited the form takes the wide column, the figures and history stack beside it. */}
          <div className={editable ? styles.side : styles.contents}>
            {canSeeMoney && (
              <Panel title={t('quotes.sections.sum')} icon={<Money16Regular />}>
                <div className={styles.well}>
                  <div className={styles.total}>{formatMoney(monthly)}</div>
                  <Text className={styles.muted}>{t('quotes.perMonthExVat')}</Text>
                  {unpriced > 0 && <Text className={styles.muted}>{t('quotes.unpricedLines', { count: unpriced })}</Text>}
                </div>
                <DetailList
                  items={[
                    { label: t('quotes.fields.oneTime'), value: formatMoney(oneTime) },
                    { label: t('quotes.fields.contractValue'), value: formatMoney(oneTime + monthly * term) },
                    {
                      label: t('quotes.fields.maxDiscount'),
                      value: isNew ? null : t('quotes.discountOf', { pct: quote!.maxDiscountPct }),
                    },
                  ]}
                />
              </Panel>
            )}

            {!isNew && <QuoteHistoryPanel quote={quote!} canSeeMoney={canSeeMoney} />}
          </div>
        </div>

        {editable ? (
          <QuoteLinesEditor
            lines={form.lines}
            onChange={(lines) => setForm({ ...form, lines })}
            discountLimitPct={quote?.discountLimitPct ?? 15}
            canSeeMoney={canSeeMoney}
          />
        ) : (
          <QuoteLinesTable lines={quote!.lines} canSeeMoney={canSeeMoney} />
        )}

        <Panel title={t('quotes.sections.texts')} icon={<TextAlignLeft16Regular />}>
          {editable ? (
            <div className={styles.formGrid}>
              <Field label={t('quotes.fields.introText')} className={styles.wide}>
                <Textarea rows={3} value={form.introText} onChange={(_, d) => setForm({ ...form, introText: d.value })} />
              </Field>
              <Field label={t('quotes.fields.termsText')} className={styles.wide}>
                <Textarea rows={4} value={form.termsText} onChange={(_, d) => setForm({ ...form, termsText: d.value })} />
              </Field>
            </div>
          ) : (
            <div className={styles.texts}>
              <div className={styles.text}>
                <Text className={styles.textLabel}>{t('quotes.fields.introText')}</Text>
                <Text>{quote!.introText || t('common.none')}</Text>
              </div>
              <div className={styles.text}>
                <Text className={styles.textLabel}>{t('quotes.fields.termsText')}</Text>
                <Text>{quote!.termsText || t('common.none')}</Text>
              </div>
            </div>
          )}
        </Panel>
      </div>

      {!isNew && dialog === 'send' && (
        <SendQuoteDialog
          quote={quote!}
          contactEmail={(contacts.data ?? []).find((contact) => contact.id === quote!.contactId)?.email ?? ''}
          contactName={quote!.contactName ?? ''}
          onClose={() => setDialog(null)}
          onSend={async (request) => {
            const ok = await run(t('quotes.sent'), () => actions.send.mutateAsync(request));
            if (ok) setDialog(null);
          }}
          pending={actions.send.isPending}
        />
      )}
      {!isNew && dialog === 'transfer' && (
        <TransferQuoteDialog
          quote={quote!}
          leavesScope={ownQuotesOnly}
          pending={actions.transfer.isPending}
          onClose={() => setDialog(null)}
          onTransfer={(owner) => void transfer(owner)}
        />
      )}
      {!isNew && (dialog === 'reject' || dialog === 'decline') && (
        <ReasonDialog
          title={dialog === 'reject' ? t('quotes.rejectTitle') : t('quotes.declineTitle')}
          label={dialog === 'reject' ? t('quotes.rejectReason') : t('quotes.declineReasonLabel')}
          confirmLabel={dialog === 'reject' ? t('quotes.reject') : t('quotes.decline')}
          required={dialog === 'reject'}
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            const ok =
              dialog === 'reject'
                ? await run(t('quotes.rejected'), () => actions.reject.mutateAsync(reason))
                : await run(t('quotes.declined'), () => actions.decline.mutateAsync(blankToNull(reason)));
            if (ok) setDialog(null);
          }}
        />
      )}
    </>
  );
}
