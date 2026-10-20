import { useState } from 'react';
import { Toaster } from '@fluentui/react-components';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { TOASTER_ID } from '../../app/toaster';
import { testUser } from '../../test/renderWithProviders';
import { TaskTicketButton } from './TaskTicketButton';
import type { Activity } from './types';

export function TaskTicketTestHost({ permissions, activity }: { permissions: string[]; activity: Activity }) {
  const [user, setUser] = useState(testUser(permissions)); const [current, setCurrent] = useState(activity);
  return <CurrentUserContext.Provider value={user}><Toaster toasterId={TOASTER_ID} />
    <button onClick={() => setUser({ ...user, id: 'employee-two' })}>Change employee</button>
    <button onClick={() => setUser({ ...user, permissions: ['activities.read', 'service.read'] })}>Drop write and time</button>
    <button onClick={() => setUser({ ...user, permissions: ['activities.read'] })}>Drop Service</button>
    <button onClick={() => setCurrent({ ...current, organizationId: 'customer-two', organizationName: 'Synthetic customer two' })}>Change customer</button>
    <button onClick={() => setCurrent({ ...current, id: 'task-two', subject: 'Synthetic task-two' })}>Change task</button>
    <TaskTicketButton activity={current} />
  </CurrentUserContext.Provider>;
}

