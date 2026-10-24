import { useState } from 'react';
import {
  Button,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Text,
  Textarea,
  makeStyles,
} from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { UserPicker } from '../../shared/components/UserPicker';
import { blankToNull } from '../../shared/utils/format';
import type { Quote } from './types';

const useStyles = makeStyles({
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: '12px 16px', alignItems: 'start', '& .fui-Dropdown, & .fui-Combobox': { minWidth: 0 } },
  wide: { gridColumn: '1 / -1' },
  muted: { color: h.muted, fontSize: '12px' },
});

/** Hands the quote, with its earlier versions, to another person (DEV-09). */
export function TransferQuoteDialog({
  quote,
  leavesScope,
  pending,
  onClose,
  onTransfer,
}: {
  quote: Quote;
  leavesScope: boolean;
  pending: boolean;
  onClose: () => void;
  onTransfer: (owner: { id: string; displayName: string }) => void;
}) {
  const { t } = useTranslation();
  const [owner, setOwner] = useState<{ id: string; displayName: string } | null>(null);
  const unchanged = owner !== null && owner.id === quote.owner?.id;

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{t('quotes.transfer.title', { number: quote.number })}</DialogTitle>
          <DialogContent>
            <Field label={t('quotes.transfer.owner')} required>
              <UserPicker value={owner} onChange={setOwner} />
            </Field>
            <p>{t('quotes.transfer.body')}</p>
            {leavesScope && <p>{t('quotes.transfer.leavesScope')}</p>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button appearance="primary" disabled={pending || owner === null || unchanged} onClick={() => owner && onTransfer(owner)}>
              {t('quotes.transfer.submit')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function SendQuoteDialog({
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

export function ReasonDialog({
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
