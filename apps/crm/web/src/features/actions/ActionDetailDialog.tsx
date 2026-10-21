import { useEffect, useRef, useState } from 'react';
import {
  Button, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Link, MessageBar, MessageBarBody, Text, makeStyles,
} from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { Dialog } from '../../shared/components/Dialog';
import { FactGrid } from '../../shared/components/Panel';
import { useKeptWhileClosing } from '../../shared/components/useKeptWhileClosing';
import { formatDateTime } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { systemName } from '../integrations/labels';
import { cancelAction, useAction, useRefreshActions } from './api';
import { ActionStatusBadge } from './ActionStatusBadge';
import { SettleFields } from './ActionSettleForm';
import { useSettlement } from './settlement';
import { actionErrorText, kindName, outcomeText } from './actionText';
import type { VendorAction } from './types';

const useStyles = makeStyles({
  content: { display: 'grid', gap: '14px', gridTemplateColumns: 'minmax(0, 1fr)', overflowWrap: 'anywhere' },
  status: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 10px' },
  quote: { margin: 0, paddingLeft: '12px', borderLeft: `3px solid ${h.line2}`, whiteSpace: 'pre-wrap', color: h.text },
  muted: { color: h.muted, fontSize: '13px', lineHeight: '20px' },
  // The ways to the ticket: at the vendor and in Parasoll, side by side while they fit; each with a 24 px hit box (WCAG 2.5.8).
  links: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '20px', rowGap: '4px' },
  link: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', '& svg': { flexShrink: 0 } },
});

/**
 * One action of the log (M39.1): what was asked, by whom and why, what the worker did, the ways to its ticket (at the vendor and in
 * Parasoll) — and, for an action without a clear outcome, the person's verdict after checking at the vendor. Settling sends nothing:
 * asking again is a new action. `ticketShown`: the card opens over the ticket it concerns, so it offers no way to it.
 */
export function ActionDetailDialog({ action, onClose, ticketShown = false }: { action: VendorAction | null; onClose: () => void; ticketShown?: boolean }) {
  const shown = useKeptWhileClosing(action);
  return <Dialog open={action !== null} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
    <DialogSurface>{shown && <Detail key={shown.id} initial={shown} onClose={onClose} ticketShown={ticketShown} />}</DialogSurface>
  </Dialog>;
}

function Detail({ initial, onClose, ticketShown }: { initial: VendorAction; onClose: () => void; ticketShown: boolean }) {
  const { t } = useTranslation(); const styles = useStyles(); const refresh = useRefreshActions();
  const action = useAction(initial.id, initial).data ?? initial;
  const settlement = useSettlement();
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const alive = useRef(true); const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // The card opens on its way out, as a confirmation does: Fluent's first focus would land on the link that leaves for Atera.
  useEffect(() => {
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  const text = typeof action.parameters.text === 'string' ? action.parameters.text : null;

  const run = async (change: () => Promise<VendorAction>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const changed = await change();
      if (alive.current) refresh(changed);
    } catch (failure) {
      if (alive.current) setError(failure);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const uncertain = action.status === 'Uncertain';

  return <form onSubmit={(event) => { event.preventDefault(); if (uncertain && settlement.ready) void run(() => settlement.settle(action)); }}>
    <DialogBody>
      <DialogTitle>{`${kindName(t, action.system, action.kind)} · ${action.targetName}`}</DialogTitle>
      <DialogContent className={styles.content}>
        <div className={styles.status} role="status">
          <ActionStatusBadge status={action.status} />
          <Text>{outcomeText(t, action) || t(`actions.status.${action.status}`)}</Text>
        </div>
        {text && <blockquote className={styles.quote}>{text}</blockquote>}
        <FactGrid items={[
          { label: t('actions.fields.requestedBy'), value: action.requestedByName ?? '—' },
          { label: t('actions.fields.requestedAt'), value: formatDateTime(action.requestedAt) },
          { label: t('actions.fields.source'), value: systemName(t, action.system) },
          ...(action.organizationName ? [{ label: t('actions.fields.customer'), value: action.organizationName }] : []),
          ...(action.reason ? [{ label: t('actions.fields.reason'), value: action.reason }] : []),
          ...(action.completedAt ? [{ label: t('actions.fields.completedAt'), value: formatDateTime(action.completedAt) }] : []),
          ...(action.attempts > 1 ? [{ label: t('actions.fields.attempts'), value: String(action.attempts) }] : []),
          ...(action.closedByName ? [{ label: t('actions.fields.closedBy'), value: `${action.closedByName}${action.closeReason ? ` — ${action.closeReason}` : ''}` }] : []),
        ]} />
        {uncertain && <Text className={styles.muted}>{t('actions.settle.intro', { system: systemName(t, action.system) })}</Text>}
        <ActionLinks action={action} ticketShown={ticketShown} onLeave={onClose} />
        {uncertain && <SettleFields action={action} settlement={settlement} disabled={busy} />}
        {error !== null && <MessageBar intent="error" layout="multiline"><MessageBarBody role="alert">{actionErrorText(t, error)}</MessageBarBody></MessageBar>}
      </DialogContent>
      <DialogActions>
        <Button ref={closeRef} onClick={onClose} disabled={busy}>{t('common.close')}</Button>
        {action.status === 'Scheduled' || action.status === 'Queued'
          ? <Button onClick={() => void run(() => cancelAction(action))} disabled={busy}>{t('actions.dialog.cancelAction')}</Button> : null}
        {uncertain && <Button appearance="primary" type="submit" disabled={!settlement.ready || busy}>{t('actions.settle.confirm')}</Button>}
      </DialogActions>
    </DialogBody>
  </form>;
}

/**
 * The ways to the ticket an action concerns: "Check in Atera" (the ticket at the vendor, where a person looks when the answer was
 * unclear) and "Open the ticket" in Parasoll — left out over that ticket's own panel, and for someone who cannot read tickets.
 */
export function ActionLinks({ action, ticketShown = false, onLeave }: { action: VendorAction; ticketShown?: boolean; onLeave?: () => void }) {
  const { t } = useTranslation(); const styles = useStyles();
  const canReadTickets = useCan(Permissions.serviceRead);
  const vendor = safeHttpUrl(action.vendorUrl);
  const ticket = !ticketShown && canReadTickets && action.ticketId ? action.ticketId : null;
  if (!vendor && !ticket) return null;
  const system = systemName(t, action.system);
  return <div className={styles.links}>
    {vendor && <Link href={vendor} target="_blank" rel="noopener noreferrer" className={styles.link}>
      <span>{action.status === 'Uncertain' ? t('actions.dialog.openAtVendor', { system }) : t('tickets.panel.openInSource', { name: system })}</span>
      <Open16Regular aria-hidden /></Link>}
    {ticket && <AppLink to={`/tickets?ticket=${encodeURIComponent(ticket)}`} className={styles.link} onClick={onLeave}>{t('actions.dialog.openTicket')}</AppLink>}
  </div>;
}
