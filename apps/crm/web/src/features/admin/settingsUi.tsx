import type { ReactNode } from 'react';
import { Avatar } from '@fluentui/react-components';
import { useSettingsStyles } from './settingsStyles';

// The style hook lives in a .ts file (fast refresh); pages import it from here together with the components.
// eslint-disable-next-line react-refresh/only-export-components
export { useSettingsStyles } from './settingsStyles';

/** Avatar, name and a muted e-mail (or role) line: the person cell of the settings tables. `nameId` lets a row's control name its person. */
export function PersonCell({ name, detail, size = 32, nameId }: { name: string; detail?: ReactNode; size?: 24 | 28 | 32 | 36; nameId?: string }) {
  const styles = useSettingsStyles();
  return (
    <span className={styles.person}>
      <Avatar name={name} size={size} color="colorful" aria-hidden />
      <span className={styles.personText}>
        <span id={nameId} className={styles.personName}>{name}</span>
        {detail && <span className={styles.personMail}>{detail}</span>}
      </span>
    </span>
  );
}

// IconChip lives in its own module: the sign-in screens use it, and they are part of the first download.
export { IconChip } from './IconChip';
