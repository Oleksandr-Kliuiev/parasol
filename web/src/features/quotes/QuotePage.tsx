import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
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
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { ArrowDownload20Regular, Send20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { DetailList, Panel } from '../../shared/components/Panel';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull, formatDate, formatDateTime, formatMoney, parseDecimal } from '../../shared/utils/format';
import { NotFoundPage } from '../errors/NotFoundPage';
import { OrganizationPicker } from '../contracts/OrganizationPicker';
import { useOrganizationContacts, useQuote, useQuoteActions, useQuoteTemplates, quotePdfUrl } from './api';
import { QuoteLinesEditor, QuoteLinesTable } from './QuoteLines';
import { emptyLine, lineAmount, toDraft, type LineDraft } from './lineDraft';
import { QuoteStatusBadge } from './shared';
import type { Quote, QuoteRequest } from './types';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM },
  wide: { gridColumn: '1 / -1' },
  total: { fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  versions: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
  texts: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '68ch' },
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
  const isNew = quote === null;
  const actions = useQuoteActions(quote?.id);
  const templates = useQuoteTemplates();
  const [form, setForm] = useState<FormState>(() =>
    quote
      ? formOf(quote)
      : emptyForm(params.get('organizationId') ? { id: params.get('organizationId')!, name: params.get('organizationName') ?? '' } : null),
  );
  const [dialog, setDialog] = useState<'send' | 'reject' | 'decline' | null>(null);
  const contacts = useOrganizationContacts(form.organization?.id);
  const restoreFocusTarget = useRestoreFocusTarget();

  const editable = canWrite && (isNew || Boolean(quote?.isEditable));
  const monthly = form.lines.filter((line) => line.recurrence === 'Monthly').reduce((sum, line) => sum + lineAmount(line), 0);
  const oneTime = form.lines.filter((line) => line.recurrence === 'OneTime').reduce((sum, line) => sum + lineAmount(line), 0);
  const term = Number(form.termMonths) || 0;

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
          <div className={styles.actions}>
            {editable && (
              <Button appearance="primary" disabled={actions.create.isPending || actions.update.isPending} onClick={() => void save()}>
                {isNew ? t('quotes.create') : t('common.save')}
              </Button>
            )}
            {!isNew && editable && quote!.lines.length > 0 && (
              <Button onClick={() => void run(t('quotes.submitted'), () => actions.submit.mutateAsync())}>{t('quotes.submit')}</Button>
            )}
            {!isNew && quote!.status === 'PendingApproval' && canApproveDiscount && (
              <>
                <Button appearance="primary" onClick={() => void run(t('quotes.approved'), () => actions.approve.mutateAsync())}>
                  {t('quotes.approve')}
                </Button>
                <Button {...restoreFocusTarget} onClick={() => setDialog('reject')}>
                  {t('quotes.reject')}
                </Button>
              </>
            )}
            {!isNew && quote!.status === 'PendingApproval' && canWrite && (
              <Button appearance="subtle" onClick={() => void run(t('quotes.withdrawn'), () => actions.withdraw.mutateAsync())}>
                {t('quotes.withdraw')}
              </Button>
            )}
            {!isNew && quote!.hasDocument && canSeeMoney && (
              <Button icon={<ArrowDownload20Regular />} as="a" href={quotePdfUrl(quote!.id)} target="_blank" rel="noopener noreferrer">
                {t('quotes.downloadPdf')}
              </Button>
            )}
            {!isNew && canWrite && (quote!.status === 'Ready' || quote!.status === 'Sent') && (
              <>
                <Button {...restoreFocusTarget} icon={<Send20Regular />} onClick={() => setDialog('send')}>
                  {t('quotes.send')}
                </Button>
                <Button appearance="primary" onClick={() => void run(t('quotes.accepted'), () => actions.accept.mutateAsync())}>
                  {t('quotes.accept')}
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
          </div>
        }
      />

      {!isNew && quote!.status === 'PendingApproval' && (
        <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>
            {t('quotes.awaitingApprovalBody', { pct: quote!.maxDiscountPct, limit: quote!.discountLimitPct })}
          </MessageBarBody>
        </MessageBar>
      )}
      {!isNew && quote!.rejectedReason && quote!.status === 'Draft' && (
        <MessageBar intent="error" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{t('quotes.rejectedBody', { reason: quote!.rejectedReason })}</MessageBarBody>
        </MessageBar>
      )}
      {!isNew && quote!.status === 'Accepted' && (
        <MessageBar intent="success" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{t('quotes.acceptedBody', { date: formatDate(quote!.decidedOn) })}</MessageBarBody>
          <MessageBarActions>
            <AppLink to={`/contracts?search=${encodeURIComponent(quote!.title)}`}>{t('quotes.openDraftContract')}</AppLink>
          </MessageBarActions>
        </MessageBar>
      )}
      {!isNew && quote!.status === 'Ready' && !quote!.canSendByEmail && (
        <MessageBar intent="info" style={{ marginBottom: tokens.spacingVerticalM }}>
          <MessageBarBody>{t('quotes.emailDisabled')}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.stack}>
        <div className={styles.grid}>
          <Panel title={t('quotes.sections.quote')}>
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
                        : (quote?.contactName ?? '')
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
                <Field label={t('quotes.fields.owner')}>
                  <UserPicker
                    value={form.ownerId ? { id: form.ownerId, displayName: form.ownerName ?? '' } : null}
                    onChange={(user) => setForm({ ...form, ownerId: user?.id ?? null, ownerName: user?.displayName ?? null })}
                  />
                </Field>
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

          {canSeeMoney && (
            <Panel title={t('quotes.sections.sum')}>
              <div className={styles.total}>{formatMoney(monthly)}</div>
              <Text className={styles.muted}>{t('quotes.perMonthExVat')}</Text>
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

          {!isNew && (
            <Panel title={t('quotes.sections.history')}>
              <DetailList
                items={[
                  { label: t('quotes.fields.issuedOn'), value: formatDate(quote!.issuedOn) },
                  { label: t('quotes.fields.approvedBy'), value: quote!.approvedBy?.name },
                  { label: t('quotes.fields.sentTo'), value: quote!.sentTo },
                  { label: t('quotes.fields.sentAt'), value: quote!.sentAt ? formatDateTime(quote!.sentAt) : null },
                  { label: t('quotes.fields.declineReason'), value: quote!.declineReason },
                ]}
              />
              <ul className={styles.versions} style={{ marginTop: tokens.spacingVerticalS }}>
                {quote!.versions.map((version) => (
                  <li key={version.id}>
                    {version.id === quote!.id ? (
                      <Text weight="semibold">{t('quotes.versionLine', { version: version.versionNo, status: t(`quotes.status.${version.status}`) })}</Text>
                    ) : (
                      <AppLink to={`/quotes/${version.id}`}>
                        {t('quotes.versionLine', { version: version.versionNo, status: t(`quotes.status.${version.status}`) })}
                      </AppLink>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
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

        <Panel title={t('quotes.sections.texts')}>
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
              <Text>{quote!.introText}</Text>
              <Text className={styles.muted}>{quote!.termsText}</Text>
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

function SendQuoteDialog({
  quote,
  contactEmail,
  contactName,
  onClose,
  onSend,
  pending,
}: {
  quote: Quote;
  contactEmail: string;
  contactName: string;
  onClose: () => void;
  onSend: (request: { toAddress: string; toName: string | null; cc: string[]; subject: string | null; message: string | null }) => Promise<void>;
  pending: boolean;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [toAddress, setToAddress] = useState(contactEmail);
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(t('quotes.mailSubject', { number: quote.number, title: quote.title }));
  const [message, setMessage] = useState('');

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('quotes.sendTitle', { number: quote.number })}</DialogTitle>
          <DialogContent>
            <div className={styles.formGrid}>
              <Field label={t('quotes.fields.toAddress')} required className={styles.wide}>
                <Input type="email" value={toAddress} onChange={(_, d) => setToAddress(d.value)} />
              </Field>
              <Field label={t('quotes.fields.cc')} hint={t('quotes.ccHint')} className={styles.wide}>
                <Input value={cc} onChange={(_, d) => setCc(d.value)} />
              </Field>
              <Field label={t('quotes.fields.subject')} className={styles.wide}>
                <Input value={subject} onChange={(_, d) => setSubject(d.value)} />
              </Field>
              <Field label={t('quotes.fields.message')} className={styles.wide}>
                <Textarea rows={4} value={message} onChange={(_, d) => setMessage(d.value)} />
              </Field>
            </div>
            <Text className={styles.muted}>{t('quotes.sendExplainer')}</Text>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              appearance="primary"
              disabled={pending || toAddress.trim() === ''}
              onClick={() =>
                void onSend({
                  toAddress: toAddress.trim(),
                  toName: blankToNull(contactName),
                  cc: cc
                    .split(/[,;]/)
                    .map((part) => part.trim())
                    .filter((part) => part !== ''),
                  subject: blankToNull(subject),
                  message: blankToNull(message),
                })
              }
            >
              {t('quotes.send')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function ReasonDialog({
  title,
  label,
  confirmLabel,
  required,
  onClose,
  onSubmit,
}: {
  title: string;
  label: string;
  confirmLabel: string;
  required: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            <Field label={label} required={required}>
              <Textarea rows={3} value={reason} onChange={(_, d) => setReason(d.value)} />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button appearance="primary" disabled={required && reason.trim() === ''} onClick={() => void onSubmit(reason)}>
              {confirmLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
