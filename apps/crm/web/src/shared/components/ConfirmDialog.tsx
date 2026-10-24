import { useEffect, useRef, type ReactNode } from 'react';
import { Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Text, makeStyles } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Dialog } from './Dialog';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '12px', gridTemplateColumns: 'minmax(0, 1fr)' },
  error: { color: h.emberT },
});

/**
 * The question before an action that cannot be undone (UX 2026): the title names the record, the body says what follows,
 * and the one primary button repeats the action. Cancel comes first and takes the focus, so a stray Enter changes nothing.
 */
export function ConfirmDialog({ open, title, children, confirm, cancel, busy = false, blocked = false, error, onConfirm, onCancel }: {
  open: boolean; title: string; children?: ReactNode; confirm: string; busy?: boolean;
  /** The way out, when "Cancel" would read as the action itself ("Keep editing" beside "Discard"). */
  cancel?: string;
  /** The action cannot go ahead yet; the body says why. */
  blocked?: boolean; error?: string | null; onConfirm: () => void; onCancel: () => void;
}) {
  const styles = useStyles();
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Fluent focuses the first focusable element of the surface, which is a link when the body has one ("Show waiting
  // entries"): the way out takes the focus after it, as the comment above promises.
  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const frame = requestAnimationFrame(() => cancelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open && !busy) onCancel(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent className={styles.content}>
            {children}
            {error && <Text block role="alert" className={styles.error}>{error}</Text>}
          </DialogContent>
          <DialogActions>
            <Button ref={cancelRef} onClick={onCancel} disabled={busy}>{cancel ?? t('common.cancel')}</Button>
            <Button appearance="primary" onClick={onConfirm} disabled={busy || blocked}>{confirm}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
