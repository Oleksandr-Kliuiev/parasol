import { Button, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';

export interface ConflictDetails {
  /** Fields the user and the latest version both changed, with the two values. */
  conflicts: { label: string; mine: string; theirs: string }[];
  /** Fields only the latest version changed. */
  changedByOthers: string[];
}

interface ConflictBarProps {
  /** Null while the latest version is being read. */
  details: ConflictDetails | null;
  /** Discard the draft and show the latest version. */
  onUseLatest: () => void;
  /** Lay the draft over the latest version for the user to review and save again. */
  onKeepMine: () => void;
}

/** A save was refused with 412: show what differs and offer both ways forward, never an overwrite in silence. */
export function ConflictBar({ details, onUseLatest, onKeepMine }: ConflictBarProps) {
  const { t } = useTranslation();
  return (
    <MessageBar intent="error" layout="multiline" role="alert">
      <MessageBarBody>
        <MessageBarTitle>{t('forms.conflict.title')}</MessageBarTitle>
        {t('forms.conflict.body')}
        {details === null ? (
          <p>{t('common.loading')}</p>
        ) : (
          <>
            {details.conflicts.length > 0 && (
              <>
                <p>{t('forms.conflict.sameFields')}</p>
                <ul>
                  {details.conflicts.map((c) => (
                    <li key={c.label}>
                      <strong>{c.label}</strong>: {t('forms.conflict.mine')} <q>{c.mine || '—'}</q>, {t('forms.conflict.theirs')} <q>{c.theirs || '—'}</q>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {details.changedByOthers.length > 0 && (
              <p>{t('forms.conflict.otherFields', { fields: details.changedByOthers.join(', ') })}</p>
            )}
          </>
        )}
      </MessageBarBody>
      <MessageBarActions>
        <Button size="small" appearance="primary" disabled={details === null} onClick={onKeepMine}>
          {t('forms.conflict.keepMine')}
        </Button>
        <Button size="small" disabled={details === null} onClick={onUseLatest}>
          {t('forms.conflict.useLatest')}
        </Button>
      </MessageBarActions>
    </MessageBar>
  );
}
