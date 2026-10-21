import { makeStyles } from '@fluentui/react-components';
import { h } from '../../app/hearth';

const useStyles = makeStyles({
  none: { color: h.faint, fontWeight: 500 },
  hidden: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
});

/** An empty table cell: a faint dash, so the column does not look broken, that screen readers hear as words. */
export function NoValue({ label }: { label: string }) {
  const styles = useStyles();
  return (
    <span className={styles.none}>
      <span aria-hidden>—</span>
      <span className={styles.hidden}>{label}</span>
    </span>
  );
}
