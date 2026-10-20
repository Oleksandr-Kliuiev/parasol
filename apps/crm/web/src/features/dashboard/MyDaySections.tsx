import { useEffect, useRef, type ReactNode } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { AppLink } from '../../shared/components/AppLink';
import { maintainSectionPosition } from './maintainSectionPosition';

const ids = { tasks: 'my-day-tasks', attention: 'my-day-attention' } as const;
const useStyles = makeStyles({
  links: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalM,
    marginBottom: tokens.spacingVerticalL,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' } },
  link: { display: 'inline-flex', alignItems: 'center', minHeight: '32px', paddingInline: tokens.spacingHorizontalS,
    paddingBlock: tokens.spacingVerticalXS },
  target: { scrollMarginBlockStart: '64px', minWidth: 0,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px', borderRadius: tokens.borderRadiusLarge } },
});

/** Keep the section in the query string, which the existing sign-in return path preserves. */
export function MyDaySectionLinks({ tasks, attention }: { tasks: boolean; attention: boolean }) {
  const { t } = useTranslation(); const styles = useStyles(); const { search, hash, key } = useLocation();
  const navigate = useNavigate();
  const value = new URLSearchParams(search).get('section');
  const section = value === 'tasks' || value === 'attention' ? value : null;
  const url = search + hash;
  const links = useRef<HTMLElement>(null);
  const previous = useRef<{ section: keyof typeof ids | null; url: string } | null>(null);
  const origin = useRef<string | null>(null);
  useEffect(() => {
    const last = previous.current;
    const target = section ? document.getElementById(ids[section]) : null;
    // Give ScrollRestoration the same target and a unique entry on a fresh load.
    if (section && section !== last?.section && target && (hash !== `#${ids[section]}` || key === 'default')) {
      void navigate({ search, hash: `#${ids[section]}` }, { replace: true });
      return;
    }
    previous.current = { section, url };
    if (section === last?.section) return;
    if (!section) {
      if (last?.section && url === origin.current) links.current?.focus({ preventScroll: true });
      return;
    }
    if (!last?.section) origin.current = last?.url ?? null;
    if (!target) return;
    target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' });
    return maintainSectionPosition(target);
  }, [section, url, search, hash, key, navigate]);
  const to = (name: keyof typeof ids) => {
    const parameters = new URLSearchParams(search); parameters.set('section', name);
    return `?${parameters}#${ids[name]}`;
  };
  if (!tasks && !attention) return null;
  return <nav ref={links} tabIndex={-1} className={styles.links} aria-label={t('myDay.sectionsLabel')}>
    {tasks && <AppLink className={styles.link} to={to('tasks')}>{t('myDay.myTasks')}</AppLink>}
    {attention && <AppLink className={styles.link} to={to('attention')}>{t('parasolAttention.title')}</AppLink>}
  </nav>;
}

export function MyDaySection({ name, children }: { name: keyof typeof ids; children: ReactNode }) {
  const styles = useStyles();
  return <div id={ids[name]} tabIndex={-1} className={styles.target}>{children}</div>;
}
