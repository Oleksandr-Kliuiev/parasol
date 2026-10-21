import { useTranslation } from 'react-i18next';
import type { AuditEntry } from '../../api/types';

/** Who acted: a signed-in person, a user whose session row has no name, an unauthenticated request, or the system. */
export type ActorKind = 'person' | 'user' | 'anonymous' | 'system';

type Actor = Pick<AuditEntry, 'userId' | 'userName'>;

export function actorKind(entry: Actor): ActorKind {
  if (entry.userName === 'anonymous') return 'anonymous';
  if (entry.userName) return 'person';
  return entry.userId ? 'user' : 'system';
}

/** The actor's name, or what kind of actor it was when the entry names nobody. */
export function useActorName() {
  const { t } = useTranslation();
  return (entry: Actor) => {
    const kind = actorKind(entry);
    return kind === 'person' ? entry.userName! : t(`audit.actor.${kind}`);
  };
}
