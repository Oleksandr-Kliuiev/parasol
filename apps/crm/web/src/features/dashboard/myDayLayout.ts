import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { CurrentUser } from '../../api/types';
import { currentUserQueryKey, useCurrentUser } from '../../auth/CurrentUserContext';
import { availableProfiles, myDayProfile, type MyDayProfile } from './myDayProfile';

/**
 * The person's own My day layout (M38), saved the moment they choose it. The page follows the choice at once; the saves go
 * out one after another, so the last choice is the one stored. A save that fails puts back the layout last saved and says so.
 */
export function useMyDayLayout() {
  const user = useCurrentUser();
  const client = useQueryClient();
  const saved = myDayProfile(user.myDayLayout, user.permissions);
  const [chosen, setChosen] = useState<MyDayProfile | null>(null);
  const [failed, setFailed] = useState(false);
  // What the server confirmed in this visit; null means the layout the signed-in user came with.
  const confirmed = useRef<MyDayProfile | null>(null);
  const latest = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const choose = (next: MyDayProfile) => {
    const attempt = ++latest.current;
    setChosen(next); setFailed(false);
    queue.current = queue.current.then(async () => {
      try {
        await api.put('/api/v1/identity/me/my-day-layout', { layout: next });
        confirmed.current = next;
        // The signed-in user carries the choice, so My day opens with it again; the server's answer follows.
        client.setQueryData<CurrentUser>(currentUserQueryKey, (current) => current && { ...current, myDayLayout: next });
        void client.invalidateQueries({ queryKey: currentUserQueryKey });
      } catch {
        // A later choice is already on its way: its own outcome decides what the page shows.
        if (attempt === latest.current) { setChosen(confirmed.current); setFailed(true); }
      }
    });
  };

  return { layout: chosen ?? saved, options: availableProfiles(user.permissions), choose, failed };
}
