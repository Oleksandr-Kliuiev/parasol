import { useState } from 'react';
import { Avatar, Button, Field, Text, makeStyles, mergeClasses } from '@fluentui/react-components';
import { Dismiss16Regular, People16Regular, People24Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import type { UserRef } from '../../api/types';
import { h } from '../../app/hearth';
import { EmptyState } from '../../shared/components/EmptyState';
import { Panel } from '../../shared/components/Panel';
import { UserPicker } from '../../shared/components/UserPicker';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useProjectActions } from './api';
import type { Project } from './types';

const useStyles = makeStyles({
  hint: { maxWidth: '75ch', color: h.muted, fontSize: '13px', lineHeight: '18px', marginBottom: '12px' },
  members: { display: 'flex', flexWrap: 'wrap', gap: '8px', listStyleType: 'none', margin: 0, marginBottom: '14px', padding: 0 },
  // A person on the team as a pill: avatar, name and, for an editor, the remove button.
  member: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minHeight: '36px',
    paddingLeft: '6px',
    paddingRight: '14px',
    boxSizing: 'border-box',
    backgroundColor: h.surface2,
    border: `1px solid ${h.line}`,
    borderRadius: '999px',
  },
  memberEditable: { paddingRight: '4px' },
  memberName: { fontSize: '13px', fontWeight: 600 },
  addMember: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '12px' },
});

/** The project's team (DEV-09): with the manager and the task assignees, they are the people who see the project. */
export function ProjectTeam({ project, canWrite }: { project: Project; canWrite: boolean }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useProjectActions(project.id);
  const [person, setPerson] = useState<UserRef | null>(null);

  const change = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      notify(success);
      return true;
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
      return false;
    }
  };

  return (
    <Panel title={t('projects.team.title')} icon={<People16Regular />}>
      <Text block className={styles.hint}>{t('projects.team.hint')}</Text>
      {project.members.length === 0 ? (
        <EmptyState icon={<People24Regular />} message={t('projects.team.empty')} />
      ) : (
        <ul className={styles.members}>
          {project.members.map((member) => (
            <li key={member.id} className={mergeClasses(styles.member, canWrite && styles.memberEditable)}>
              <Avatar name={member.name} size={24} color="colorful" aria-hidden />
              <Text className={styles.memberName}>{member.name}</Text>
              {canWrite && (
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<Dismiss16Regular />}
                  aria-label={t('projects.team.remove', { name: member.name })}
                  disabled={actions.removeMember.isPending}
                  onClick={() => void change(() => actions.removeMember.mutateAsync(member.id), t('projects.team.removed', { name: member.name }))}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <div className={styles.addMember}>
          <Field label={t('projects.team.person')}>
            <UserPicker value={person} onChange={setPerson} />
          </Field>
          <Button
            disabled={person === null || actions.addMember.isPending}
            onClick={() =>
              person &&
              void change(() => actions.addMember.mutateAsync(person.id), t('projects.team.added', { name: person.displayName })).then(
                (ok) => ok && setPerson(null),
              )
            }
          >
            {t('projects.team.add')}
          </Button>
        </div>
      )}
    </Panel>
  );
}
