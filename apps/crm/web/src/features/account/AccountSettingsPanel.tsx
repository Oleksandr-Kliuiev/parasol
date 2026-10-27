import { useId, type ReactNode } from 'react';
import { Text, makeStyles } from '@fluentui/react-components';
import { Options16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { useThemeMode, type ThemeMode } from '../../app/themeModeContext';
import { useChangeLanguage } from '../../auth/accountActions';
import { languages, type LanguageCode } from '../../i18n';
import { Panel } from '../../shared/components/Panel';
import { SegmentedChoice } from '../../shared/components/SegmentedChoice';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useMyDayLayout } from '../dashboard/myDayLayout';

const useStyles = makeStyles({
  rows: { display: 'grid', gap: '18px', minWidth: 0 },
  // A setting: its name, a line on what it does, then the choice under them.
  row: { position: 'relative', display: 'grid', gap: '8px', minWidth: 0, justifyItems: 'start' },
  text: { display: 'grid', gap: '2px', minWidth: 0 },
  name: { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 600, color: h.text },
  hint: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  failed: { margin: 0, color: h.emberT, fontSize: '12.5px', lineHeight: '18px' },
  // The status line stays mounted, so a failure is announced; empty, it takes no room.
  quiet: { position: 'absolute', width: '1px', height: '1px', margin: 0, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' },
});

const themeModes: readonly ThemeMode[] = ['system', 'light', 'dark'];

/** How Parasoll behaves for the signed-in person: language, what My day shows first, light or dark. */
export function AccountSettingsPanel() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const notify = useNotify();
  const changeLanguage = useChangeLanguage();
  const layout = useMyDayLayout();
  const theme = useThemeMode();
  const language = (languages.find((l) => l.code === i18n.language)?.code ?? 'nb') as LanguageCode;

  const chooseLanguage = async (code: LanguageCode) => {
    try {
      await changeLanguage(code);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Panel title={t('account.settings.title')} icon={<Options16Regular />}>
      <div className={styles.rows}>
        <Setting name={t('account.settings.language')} hint={t('account.settings.languageHint')}>
          {(label) => (
            <SegmentedChoice labelledBy={label} options={languages.map((l) => ({ value: l.code as LanguageCode, label: l.label }))} value={language} onChange={(code) => void chooseLanguage(code)} />
          )}
        </Setting>
        {layout.options.length > 1 && (
          <Setting name={t('account.settings.myDay')} hint={t('account.settings.myDayHint')} failed={layout.failed ? t('myDay.layout.saveFailed') : undefined}>
            {(label) => (
              <SegmentedChoice labelledBy={label} options={layout.options.map((option) => ({ value: option, label: t(`myDay.layout.${option}`) }))} value={layout.layout} onChange={layout.choose} />
            )}
          </Setting>
        )}
        <Setting name={t('account.settings.theme')} hint={t('account.settings.themeHint')}>
          {(label) => (
            <SegmentedChoice labelledBy={label} options={themeModes.map((mode) => ({ value: mode, label: t(`account.settings.themes.${mode}`) }))} value={theme.mode} onChange={theme.setMode} />
          )}
        </Setting>
      </div>
    </Panel>
  );
}

function Setting({ name, hint, failed, children }: { name: string; hint: string; failed?: string; children: (labelId: string) => ReactNode }) {
  const s = useStyles();
  const label = useId();
  return (
    <div className={s.row}>
      <div className={s.text}>
        <h3 id={label} className={s.name}>{name}</h3>
        <Text className={s.hint}>{hint}</Text>
      </div>
      {children(label)}
      <p role="status" className={failed ? s.failed : s.quiet}>{failed ?? ''}</p>
    </div>
  );
}
