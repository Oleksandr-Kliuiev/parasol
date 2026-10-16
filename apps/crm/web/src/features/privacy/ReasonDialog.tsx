import { useState } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Text, Textarea, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';

/** Asks for the reason a privacy decision needs (rejecting a request, releasing a hold, lifting a suppression). */
export function ReasonDialog({
  open,
  title,
  hint,
  submit,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  hint?: string;
  submit: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={(_, d) => {
        if (!d.open) {
          setReason('');
          onClose();
        }
      }}
    >
      <DialogSurface>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) onSubmit(reason.trim());
          }}
        >
          <DialogBody>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent>
              {hint && <Text block style={{ marginBottom: tokens.spacingVerticalM }}>{hint}</Text>}
              <Field label={t('privacy.reason')} required>
                <Textarea value={reason} onChange={(_, d) => setReason(d.value)} maxLength={500} />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button appearance="primary" type="submit" disabled={!reason.trim() || pending}>
                {submit}
              </Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
