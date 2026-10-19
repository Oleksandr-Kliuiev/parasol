import { useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { Toaster } from '@fluentui/react-components';
import { useQueryClient } from '@tanstack/react-query';
import { CurrentUserContext } from '../../auth/CurrentUserContext';
import { TOASTER_ID } from '../../app/toaster';
import { testUser } from '../../test/renderWithProviders';
import { ActivityTimeline } from './ActivityTimeline';
import { activitySelection, activityUrl } from './activityNavigation';

/** The route contract used by OrganizationDetailPage, with controls for external scope changes. */
export function ActivityNavigationTestHost({ allowed, otherActivityId, otherOrganizationId, activityId }: {
  allowed: string[];
  otherActivityId: string;
  otherOrganizationId: string;
  activityId: string;
}) {
  const { id = '' } = useParams(); const location = useLocation(); const navigate = useNavigate();
  const [params, setParams] = useSearchParams(); const client = useQueryClient();
  const [user, setUser] = useState(testUser(allowed));
  return <CurrentUserContext.Provider value={user}><Toaster toasterId={TOASTER_ID} />
    <button onClick={() => navigate({ pathname: location.pathname, search: location.search }, { replace: true })}>Replace URL</button>
    <button onClick={() => navigate(activityUrl(id, otherActivityId))}>Change selection</button>
    <button onClick={() => navigate(activityUrl(otherOrganizationId, activityId))}>Change customer</button>
    <button onClick={() => setUser({ ...user, id: 'employee-two' })}>Change employee</button>
    <button onClick={() => setUser({ ...user, permissions: ['activities.read'] })}>Drop write and Atlas</button>
    <button onClick={() => setUser({ ...user, permissions: [] })}>Drop read</button>
    <button onClick={() => void client.invalidateQueries({ queryKey: ['activities'] })}>Refresh current query</button>
    <ActivityTimeline organizationId={id} selection={activitySelection(params)} navigationKey={location.key}
      onShowAll={() => { const next = new URLSearchParams(params); next.delete('activityId'); next.set('tab', 'activities'); setParams(next, { replace: true }); }} />
  </CurrentUserContext.Provider>;
}
