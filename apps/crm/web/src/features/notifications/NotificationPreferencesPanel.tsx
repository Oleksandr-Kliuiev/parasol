import { useId, useState } from 'react';
import { Button, Checkbox, Field, MessageBar, MessageBarBody, Select, Spinner, Switch, Text, makeStyles } from '@fluentui/react-components';
import { Mail16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { Panel } from '../../shared/components/Panel';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useNotificationPreferences, useSaveNotificationPreferences } from './api';
import { notificationKinds, type NotificationKind } from './types';

const useStyles = makeStyles({
  preferences: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '16px', minWidth: 0 },
  // The switch and the checkboxes sit on the card's text edge, the edge the select and its label start at (the visual
  // system's controls carry no inset of their own).
  switch: { justifySelf: 'start' },
  group: { display: 'grid', gap: '6px', minWidth: 0 },
  subhead: { margin: 0, fontSize: '12.5px', lineHeight: '18px', fontWeight: 700, color: h.text },
  kinds: { display: 'grid', gap: '2px', justifyItems: 'start' },
  // The buttons of the form at its foot, on the right: Cancel, then Save.
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '10px', paddingTop: '14px', borderTop: `1px solid ${h.line}` },
});

/** What the signed-in person wants by e-mail (docs/02 §4.11); it lives on their account page. */
export function NotificationPreferencesPanel() {
  const styles = useStyles();
  const kindsLabel = useId();
  const { t } = useTranslation();
  const notify = useNotify();
  const { data, isPending } = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const [draft, setDraft] = useState<{ emailEnabled: boolean; digestHour: number; mutedKinds: NotificationKind[] } | null>(null);
  const current = draft ?? (data ? { emailEnabled: data.emailEnabled, digestHour: data.digestHour, mutedKinds: data.mutedKinds } : null);

  const submit = async () => {
    if (!current) return;
    try {
      await save.mutateAsync(current);
      setDraft(null);
      notify(t('notifications.preferencesSaved'));
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Panel title={t('notifications.preferences')} icon={<Mail16Regular />}>
      {isPending || !current ? (
        <Spinner label={t('common.loading')} />
      ) : (
        <div className={styles.preferences}>
          {!data?.emailAvailable && (
            <MessageBar intent="info">
              <MessageBarBody>{t('notifications.emailUnavailable')}</MessageBarBody>
            </MessageBar>
          )}
          <Switch
            className={styles.switch}
            label={t('notifications.emailEnabled')}
            checked={current.emailEnabled}
            disabled={!data?.emailAvailable}
            onChange={(_, d) => setDraft({ ...current, emailEnabled: d.checked })}
          />
          <Field
            label={t('notifications.digestHour')}
            hint={data?.emailAvailable && !current.emailEnabled ? t('notifications.digestOff') : t('notifications.digestHourHint')}
          >
            <Select
              value={String(current.digestHour)}
              disabled={!current.emailEnabled || !data?.emailAvailable}
              onChange={(_, d) => setDraft({ ...current, digestHour: Number(d.value) })}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {`${String(hour).padStart(2, '0')}:00`}
                </option>
              ))}
            </Select>
          </Field>
          <div className={styles.group} role="group" aria-labelledby={kindsLabel}>
          <Text id={kindsLabel} className={styles.subhead}>{t('notifications.muted')}</Text>
          <div className={styles.kinds}>
            {notificationKinds.map((kind) => (
              <Checkbox
                key={kind}
                label={t(`notifications.kindNames.${kind}`)}
                checked={!current.mutedKinds.includes(kind)}
                onChange={(_, d) =>
                  setDraft({
                    ...current,
                    mutedKinds: d.checked ? current.mutedKinds.filter((k) => k !== kind) : [...current.mutedKinds, kind],
                  })
                }
              />
            ))}
          </div>
          </div>
          <div className={styles.actions}>
            {draft !== null && <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>}
            <Button appearance="primary" disabled={draft === null || save.isPending} onClick={() => void submit()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
