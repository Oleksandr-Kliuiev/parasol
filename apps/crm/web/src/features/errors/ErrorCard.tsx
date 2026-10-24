import { useEffect, type ReactElement, type ReactNode } from 'react';
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { cardSurface, h, type Tone } from '../../app/hearth';
import { IconChip } from '../admin/IconChip';

const useStyles = makeStyles({
  // Inside the shell the card sits in the middle of the content area; outside it, in the middle of the screen.
  root: {
    display: 'grid',
    placeItems: 'center',
    minHeight: 'min(60vh, 560px)',
    paddingTop: '24px',
    paddingBottom: '24px',
    minWidth: 0,
  },
  screen: {
    minHeight: '100vh',
    paddingLeft: '16px',
    paddingRight: '16px',
    backgroundColor: h.bg,
    boxSizing: 'border-box',
  },
  card: {
    ...cardSurface,
    boxSizing: 'border-box',
    width: '100%',
    maxWidth: '480px',
    display: 'grid',
    justifyItems: 'center',
    gap: '12px',
    paddingTop: '32px',
    paddingBottom: '28px',
    paddingLeft: '28px',
    paddingRight: '28px',
    textAlign: 'center',
    overflowWrap: 'anywhere',
    '@media (max-width: 480px)': { paddingTop: '28px', paddingBottom: '24px', paddingLeft: '20px', paddingRight: '20px' },
  },
  chip: { width: '48px', height: '48px', borderRadius: '16px', marginBottom: '4px', '& svg': { width: '24px', height: '24px' } },
  title: {
    margin: 0,
    fontFamily: h.display,
    fontSize: '24px',
    lineHeight: '30px',
    fontWeight: 600,
    letterSpacing: '-0.02em',
    textWrap: 'balance',
  },
  body: { display: 'grid', gap: '8px', color: h.muted, fontSize: '14px', lineHeight: '20px', maxWidth: '40ch' },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '8px', marginTop: '8px' },
});

interface ErrorCardProps {
  icon: ReactElement;
  tone?: Tone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** Outside the app shell (sign-in paused, no access): the card fills the screen. */
  screen?: boolean;
  /** The card is the whole page: it names the browser tab, as the page header does. */
  pageTitle?: boolean;
  role?: 'alert';
  as?: 'main' | 'div';
}

/** The error and pause states of the visual system: a centred card with an icon chip, a display title, a line and the way on. */
export function ErrorCard({ icon, tone = 'neutral', title, children, actions, screen, pageTitle, role, as: Root = 'div' }: ErrorCardProps) {
  const styles = useStyles();
  useEffect(() => {
    if (!pageTitle) return;
    const text = `${title} · Parasoll`;
    document.title = text;
    return () => { if (document.title === text) document.title = 'Parasoll'; };
  }, [pageTitle, title]);
  return (
    <Root className={mergeClasses(styles.root, screen && styles.screen)}>
      <div className={styles.card} role={role}>
        <IconChip icon={icon} tone={tone} className={styles.chip} />
        <h1 className={styles.title}>{title}</h1>
        {children && <div className={styles.body}>{children}</div>}
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </Root>
  );
}
