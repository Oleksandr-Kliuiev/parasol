import type { ReactElement, ReactNode } from 'react';
import { Avatar, mergeClasses } from '@fluentui/react-components';
import { tone as tones, type Tone } from '../../app/hearth';
import { useRecordStyles } from './recordStyles';

/** Joins the parts that exist with a middle dot; each part keeps its own element (tests and screen readers read them apart). */
export function MetaLine({ parts, className }: { parts: ReactNode[]; className?: string }) {
  const styles = useRecordStyles();
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== '');
  if (shown.length === 0) return null;
  return (
    <span className={mergeClasses(styles.sub, className)}>
      {shown.map((part, index) => (
        <span key={index} style={{ display: 'contents' }}>
          {index > 0 && <span aria-hidden>·</span>}
          {part}
        </span>
      ))}
    </span>
  );
}

interface RecordCellProps {
  /** The name the avatar's initials come from (people and companies). */
  avatarName?: string;
  /** A record that is not a person or a company (contract, quote, product, project) shows a tinted icon chip instead. */
  icon?: ReactElement;
  tone?: Tone;
  /** The name as shown, usually a link to the record. */
  name: ReactNode;
  /** Parts of the muted line under the name, joined with a middle dot. */
  meta?: ReactNode[];
  size?: 28 | 32 | 36;
}

export function RecordCell({ avatarName, icon, tone = 'neutral', name, meta = [], size = 36 }: RecordCellProps) {
  const styles = useRecordStyles();
  return (
    <span className={styles.cell}>
      {icon ? (
        <span
          className={styles.chip}
          style={{ width: size, height: size, backgroundColor: tones[tone].soft, color: tones[tone].text }}
          aria-hidden
        >
          {icon}
        </span>
      ) : (
        <Avatar name={avatarName} size={size} color="colorful" aria-hidden />
      )}
      <span className={styles.text}>
        <span className={styles.name}>{name}</span>
        <MetaLine parts={meta} />
      </span>
    </span>
  );
}
