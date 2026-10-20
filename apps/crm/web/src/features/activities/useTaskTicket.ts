import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, query } from '../../api/client';
import { savedServicePolicy } from '../service/useSavedServiceList';
import type { TaskTicketAssociation } from './taskTicketTypes';

/** No shared cache, background retry or late-owner mutation callback. */
export function useTaskTicket(activityId: string, organizationId: string, scope: string) {
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const alive = useRef(false); const writing = useRef(false); const refreshing = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const url = `/api/v1/activities/${activityId}/ticket`;
  const read = useQuery({
    ...savedServicePolicy, queryKey: ['task-ticket', scope, revision],
    queryFn: async ({ signal }) => {
      const answer = await api.get<TaskTicketAssociation>(`${url}${query({ organizationId })}`, signal);
      signal.throwIfAborted(); return answer.data;
    },
  });
  useEffect(() => { if (!read.isFetching) refreshing.current = false; }, [read.isFetching, revision]);
  const available = read.isSuccess && !read.isFetching;
  const refresh = () => {
    if (writing.current || refreshing.current || read.isFetching) return;
    refreshing.current = true; setFailure(null); setConflict(false); setRevision(value => value + 1);
  };
  const save = async (ticketId: string | null) => {
    if (writing.current || !available || conflict || !read.data.etag) return false;
    writing.current = true; setPending(true); setFailure(null);
    try {
      await api.put<TaskTicketAssociation>(url, { organizationId, ticketId }, read.data.etag);
      if (!alive.current) return false;
      return true;
    } catch (error) {
      if (alive.current) {
        setFailure(error);
        if (error instanceof ApiError && [409, 412].includes(error.status)) setConflict(true);
      }
      return false;
    } finally {
      writing.current = false;
      if (alive.current) setPending(false);
    }
  };
  return { ...read, available, association: available ? read.data : null, pending, failure, conflict, refresh, save, revision };
}
