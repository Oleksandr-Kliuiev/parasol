import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Text, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowLeft20Regular } from '@fluentui/react-icons';
import { h } from '../../app/hearth';
import { ease, reveal, useMagnetic } from '../../app/motion';
import { AppLink } from './AppLink';
import { RisingTitle } from './RisingTitle';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    columnGap: '24px',
    rowGap: '16px',
    marginTop: '10px',
    marginBottom: '22px',
  },
  // The title block takes the room the actions leave. Its width is set by the title alone: the subtitle has no width of
  // its own (inline-size containment) and wraps within that room, so a long subtitle never pushes the actions down.
  lead: { display: 'flex', alignItems: 'center', gap: '14px', minWidth: 0, flexGrow: 1 },
  titles: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0, flexGrow: 1 },
  subtitleBox: { contain: 'inline-size' },
  // The back button of the reference: a 44 px icon button in front of the title, named after where it leads.
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
    transitionProperty: 'background-color, border-color, translate',
    transitionDuration: '0.15s, 0.15s, 0.5s',
    transitionTimingFunction: `ease, ease, ${ease.out}`,
    ':hover': { backgroundColor: h.surface2, borderTopColor: h.line2, borderRightColor: h.line2, borderBottomColor: h.line2, borderLeftColor: h.line2, color: h.text, textDecorationLine: 'none' },
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
  // Display type of the reference: Bricolage Grotesque, tight tracking, 28–38 px with the viewport.
  title: {
    margin: 0,
    fontFamily: h.display,
    fontSize: 'clamp(28px, 2.5vw, 38px)',
    lineHeight: 1.04,
    fontWeight: 600,
    letterSpacing: '-0.03em',
    textWrap: 'balance',
  },
  subtitle: { color: h.muted, fontSize: '14px', lineHeight: '20px', maxWidth: '75ch' },
  meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: '10px',
    marginLeft: 'auto',
    '@media (max-width: 560px)': { width: '100%', justifyContent: 'stretch', '& > .fui-Button': { flex: '1 1 auto' } },
  },
});

interface PageHeaderProps {
  title: ReactNode;
  documentTitle?: string;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}

export function PageHeader({ title, documentTitle, subtitle, meta, actions, back }: PageHeaderProps) {
  const styles = useStyles();
  const heading = useRef<HTMLHeadingElement>(null);
  const backRef = useMagnetic<HTMLSpanElement>();
  const subtitleRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const text = (documentTitle ?? heading.current?.textContent)?.replace(/\s+/g, ' ').trim();
    const pageTitle = text ? `${text} · Parasoll` : 'Parasoll';
    document.title = pageTitle;
    return () => { if (document.title === pageTitle) document.title = 'Parasoll'; };
  }, [title, documentTitle]);

  // The header builds up after the title: the way back, the sentence under it, then the actions one by one.
  useLayoutEffect(() => {
    const animations = [
      ...reveal(backRef.current, { x: -14 }, { duration: 600 }),
      ...reveal(subtitleRef.current, { y: 8 }, { delay: 120 }),
      ...reveal(actionsRef.current?.children ?? [], { y: 14 }, { delay: 160, stagger: 70 }),
    ];
    return () => animations.forEach((animation) => animation.cancel());
    // Mount only: a re-render must not replay the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.root}>
      <div className={styles.lead}>
        {back && (
          <span ref={backRef} style={{ display: 'inline-flex', transition: `translate 0.5s ${ease.out}` }}>
            <AppLink to={back.to} className={styles.back} ariaLabel={back.label} title={back.label}>
              <ArrowLeft20Regular aria-hidden />
            </AppLink>
          </span>
        )}
        <div className={styles.titles}>
          <h1 ref={heading} className={styles.title}>{typeof title === 'string' ? <RisingTitle text={title} /> : title}</h1>
          {subtitle && (
            <div ref={subtitleRef} className={styles.subtitleBox}>
              <Text className={styles.subtitle}>{subtitle}</Text>
            </div>
          )}
          {meta && <div className={styles.meta}>{meta}</div>}
        </div>
      </div>
      {actions && <div ref={actionsRef} className={styles.actions}>{actions}</div>}
    </div>
  );
}
