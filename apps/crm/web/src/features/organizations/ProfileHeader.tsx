import { useEffect, useRef, type ReactNode } from 'react';
import { Avatar, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowLeft20Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { ease, useMagnetic, useReveal } from '../../app/motion';
import { AppLink } from '../../shared/components/AppLink';
import { RisingTitle } from '../../shared/components/RisingTitle';
import { MetaLine } from './RecordCell';

const useStyles = makeStyles({
  // The reference's back button: a 44 px icon button, here at the start of the profile card, named after where it leads.
  back: {
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    width: '44px',
    height: '44px',
    borderRadius: '12px',
    border: `1px solid ${h.line}`,
    backgroundColor: h.surface,
    color: h.text,
    transitionProperty: 'background-color, border-color',
    transitionDuration: '0.15s',
    ':hover': { backgroundColor: h.surface2, borderTopColor: h.line2, borderRightColor: h.line2, borderBottomColor: h.line2, borderLeftColor: h.line2, color: h.text, textDecorationLine: 'none' },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  magnet: { position: 'relative', display: 'inline-flex', transitionProperty: 'translate', transitionDuration: '0.5s', transitionTimingFunction: ease.out },
  // The profile card of the reference's lead page: avatar, pills, the name in display type and a muted line of facts.
  card: {
    position: 'relative',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '20px',
    rowGap: '16px',
    marginTop: '10px',
    marginBottom: '20px',
    paddingTop: '22px',
    paddingBottom: '22px',
    paddingLeft: '22px',
    paddingRight: '24px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${h.line}`,
    borderRadius: '20px',
    boxShadow: tokens.shadow4,
    overflow: 'hidden',
    '@media (max-width: 600px)': { paddingTop: '16px', paddingBottom: '16px', paddingLeft: '16px', paddingRight: '16px', columnGap: '14px' },
  },
  // A soft ember glow in the corner, as on the reference's profile card.
  glow: {
    position: 'absolute',
    top: '-80px',
    right: '-60px',
    width: '280px',
    height: '220px',
    borderRadius: '50%',
    backgroundColor: h.emberSoft,
    filter: 'blur(48px)',
    opacity: 0.7,
    pointerEvents: 'none',
  },
  who: { position: 'relative', display: 'flex', alignItems: 'center', gap: '18px', minWidth: 0, flex: '1 1 420px', '@media (max-width: 600px)': { gap: '12px', flexWrap: 'wrap' } },
  avatar: { flexShrink: 0, boxShadow: `0 0 0 4px ${tokens.colorNeutralBackground1}, 0 0 0 5px ${h.line}` },
  text: { display: 'grid', gap: '6px', minWidth: 0 },
  pills: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  title: {
    margin: 0,
    fontFamily: h.display,
    fontSize: 'clamp(26px, 2.5vw, 36px)',
    lineHeight: 1.06,
    fontWeight: 600,
    letterSpacing: '-0.03em',
    overflowWrap: 'anywhere',
    textWrap: 'balance',
  },
  meta: { fontSize: '13px', lineHeight: '18px', columnGap: '8px' },
  actions: {
    position: 'relative',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '10px',
    marginLeft: 'auto',
    '@media (max-width: 560px)': { width: '100%', justifyContent: 'stretch', '& > .fui-Button': { flex: '1 1 auto' } },
  },
});

interface ProfileHeaderProps {
  title: string;
  /** The name the avatar's initials come from; defaults to the title. */
  avatarName?: string;
  back?: { to: string; label: string };
  /** Status pills above the name. */
  pills?: ReactNode;
  /** Key facts under the name, joined with a middle dot. */
  meta?: ReactNode[];
  /** Secondary controls first, the quiet destructive one last. */
  actions?: ReactNode;
  /** The open section (a tab), named first in the window title so each tab is its own page in history and bookmarks. */
  section?: string;
}

/** The head of a record page (organization, contact): the profile card instead of a bare title. */
export function ProfileHeader({ title, avatarName, back, pills, meta = [], actions, section }: ProfileHeaderProps) {
  const styles = useStyles();
  const card = useRef<HTMLDivElement>(null);
  const magnet = useMagnetic<HTMLSpanElement>();
  useReveal(card, 'card');
  useEffect(() => {
    const pageTitle = [section, title.replace(/\s+/g, ' ').trim(), 'Parasoll'].filter(Boolean).join(' · ');
    document.title = pageTitle;
    return () => { if (document.title === pageTitle) document.title = 'Parasoll'; };
  }, [title, section]);
  return (
    <>
      <div ref={card} className={styles.card}>
        <span className={styles.glow} aria-hidden />
        <div className={styles.who}>
          {back && (
            <span ref={magnet} className={styles.magnet}>
              <AppLink to={back.to} className={styles.back} ariaLabel={back.label} title={back.label}>
                <ArrowLeft20Regular aria-hidden />
              </AppLink>
            </span>
          )}
          <Avatar className={styles.avatar} name={avatarName ?? title} size={64} color="colorful" aria-hidden />
          <div className={styles.text}>
            {pills && <div className={styles.pills}>{pills}</div>}
            <h1 className={styles.title}><RisingTitle text={title} /></h1>
            <MetaLine parts={meta} className={styles.meta} />
          </div>
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </>
  );
}
