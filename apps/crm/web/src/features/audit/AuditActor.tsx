import { Avatar, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { Bot16Regular, PersonKey16Regular, PersonQuestionMark16Regular } from '@fluentui/react-icons';
import type { AuditEntry } from '../../api/types';
import { h } from '../../app/hearth';
import { IconChip } from '../admin/IconChip';
import { actorKind, useActorName } from './actor';

const useStyles = makeStyles({
  root: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 },
  // One mark size for people and for the quiet chips, so a column of actors lines up whoever acted.
  chip: { width: '28px', height: '28px', borderRadius: '9px', '& svg': { width: '14px', height: '14px' } },
  name: { fontWeight: tokens.fontWeightSemibold, fontSize: '14px', lineHeight: '20px', overflowWrap: 'anywhere', minWidth: 0 },
  quiet: { color: h.muted },
});

const icons = { user: <PersonKey16Regular />, anonymous: <PersonQuestionMark16Regular />, system: <Bot16Regular /> };

/** The mark of an actor: the person's avatar, or a neutral icon chip of the same size for the others. */
export function ActorMark({ entry }: { entry: Pick<AuditEntry, 'userId' | 'userName'> }) {
  const styles = useStyles();
  const kind = actorKind(entry);
  if (kind === 'person') return <Avatar name={entry.userName!} size={28} color="colorful" aria-hidden />;
  return <IconChip icon={icons[kind]} className={styles.chip} />;
}

/** Mark and name in one cell of the audit table. */
export function AuditActor({ entry }: { entry: Pick<AuditEntry, 'userId' | 'userName'> }) {
  const styles = useStyles();
  const name = useActorName();
  const kind = actorKind(entry);
  return (
    <span className={styles.root} title={kind === 'user' && entry.userId ? entry.userId : undefined}>
      <ActorMark entry={entry} />
      <span className={mergeClasses(styles.name, kind !== 'person' && styles.quiet)}>{name(entry)}</span>
    </span>
  );
}
