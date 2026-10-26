import { DialogSurface, FluentProvider, OverlayDrawer, makeStyles, type Theme } from '@fluentui/react-components';
import { Dialog } from '../shared/components/Dialog';
import { useTranslation } from 'react-i18next';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GlobalSearch } from './GlobalSearch';
import { h } from './hearth';
import type { SearchTypeAhead } from './searchTypeAhead';

/*
 * The parts of the shell that only appear on request — the search palette and the menu drawer of tablets and phones —
 * are loaded with the first use, so they stay out of the initial download (budget in scripts/bundle-budget.mjs).
 */

const useStyles = makeStyles({
  drawer: { width: 'min(300px, 86vw)', backgroundColor: h.sideBg, boxShadow: '30px 0 60px -20px rgba(0, 0, 0, 0.5)' },
  drawerTheme: { height: '100%', backgroundColor: h.sideBg },
  // The palette sits high on the screen, 620 px wide, as in the reference.
  searchSurface: { maxWidth: '620px', width: 'calc(100vw - 24px)', alignSelf: 'flex-start', marginTop: '12vh' },
});

export function SearchDialog({ open, onClose, typeAhead }: { open: boolean; onClose: () => void; typeAhead?: SearchTypeAhead }) {
  const styles = useStyles();
  const { t } = useTranslation();
  // The palette stays in the surface while the dialog leaves. Every opening starts a fresh one, also when Ctrl K brings
  // the dialog back before the last palette has left.
  const [opening, setOpening] = useState({ open, count: 0 });
  if (opening.open !== open) setOpening({ open, count: open ? opening.count + 1 : opening.count });
  // Closing puts focus back where it was when the palette opened: the search button, or the field Ctrl K was pressed in.
  const origin = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!open || (active instanceof HTMLElement && active.closest('[data-variant="palette"]'))) return;
    origin.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);
  const close = () => {
    if (origin.current?.isConnected) origin.current.focus();
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && close()}>
      <DialogSurface className={styles.searchSurface} aria-label={t('header.searchButton')} data-variant="palette">
        <GlobalSearch key={opening.count} inline onDone={close} onClose={close} typeAhead={typeAhead} />
      </DialogSurface>
    </Dialog>
  );
}

export function MenuDrawer({ open, onOpenChange, theme, children }: { open: boolean; onOpenChange: (open: boolean) => void; theme: Theme; children: ReactNode }) {
  const styles = useStyles();
  const { t } = useTranslation();
  return (
    <OverlayDrawer className={styles.drawer} open={open} onOpenChange={(_, data) => onOpenChange(data.open)} aria-label={t('nav.mainMenu')}>
      <FluentProvider className={styles.drawerTheme} theme={theme}>
        {children}
      </FluentProvider>
    </OverlayDrawer>
  );
}
