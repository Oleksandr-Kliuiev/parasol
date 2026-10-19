import { useState } from 'react';
import { Dialog, DialogSurface, Toaster } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { TOASTER_ID } from '../../app/toaster';
import { testUser } from '../../test/renderWithProviders';
import { TimeEntryDialog } from './TimeEntryDialog';
import type { TimeEntry } from './types';

export function TimeEntryTestHost({ initial, permissions, probeRead, nextEntry }: { initial?: TimeEntry; permissions: string[]; probeRead: () => Promise<string>; nextEntry: TimeEntry }) {
  const [user, setUser] = useState(testUser(permissions)); const [current, setCurrent] = useState(initial);
  const [open, setOpen] = useState(true);
  useQuery({ queryKey: ['time', 'form-lifetime-probe'], queryFn: probeRead, staleTime: Infinity });
  return <CurrentUserContext.Provider value={user}><Toaster toasterId={TOASTER_ID} />
    <button onClick={() => setUser({ ...user, id: 'employee-two' })}>Change employee</button>
    <button onClick={() => setUser({ ...user, permissions: [] })}>Drop time</button>
    <button onClick={() => setCurrent(nextEntry)}>Change entry</button>
    <button onClick={() => setOpen(true)}>Reopen form</button>
    <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}><DialogSurface>
      {open && <TimeEntryDialog entry={current} defaultDate="2026-10-17" onClose={() => setOpen(false)} />}
    </DialogSurface></Dialog>
  </CurrentUserContext.Provider>;
}

