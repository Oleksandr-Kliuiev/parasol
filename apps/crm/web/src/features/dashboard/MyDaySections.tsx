import { useEffect, useRef, type ReactNode } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { AppLink } from '../../shared/components/AppLink';
import { maintainSectionPosition } from './maintainSectionPosition';
import { h } from '../../app/hearth';
import { useReveal } from '../../app/motion';

const ids = { alerts: 'my-day-alerts', tasks: 'my-day-tasks' } as const;
const useStyles = makeStyles({
  links: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', borderRadius: '12px',
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' } },
  // Chips of the visual system: quick jumps to a section, not filters.
  link: { display: 'inline-flex', alignItems: 'center', minHeight: '32px', paddingLeft: '12px', paddingRight: '12px', borderRadius: '999px',
    border: `1px solid ${h.line}`, backgroundColor: tokens.colorNeutralBackground1, color: h.muted, fontSize: '12.5px', fontWeight: 700,
    textDecorationLine: 'none', ':hover': { color: h.text, border: `1px solid ${h.line2}`, textDecorationLine: 'none' } },
  target: { minWidth: 0,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px', borderRadius: tokens.borderRadiusLarge } },
});

/** Keep the section in the query string, which the existing sign-in return path preserves. */
export function MyDaySectionLinks({ alerts, tasks }: { alerts: boolean; tasks: boolean }) {
  const { t } = useTranslation(); const styles = useStyles(); const { search, hash, key } = useLocation();
  const navigate = useNavigate();
  const value = new URLSearchParams(search).get('section');
  const section = value === 'alerts' || value === 'tasks' ? value : null;
  const url = search + hash;
  const links = useRef<HTMLElement>(null);
  // The jumps rise with the rest of the page instead of standing there before the header has landed.
  useReveal(links, 'item');
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
  if (!alerts && !tasks) return null;
  return <nav ref={links} tabIndex={-1} className={styles.links} aria-label={t('myDay.sectionsLabel')}>
    {alerts && <AppLink className={styles.link} to={to('alerts')}>{t('myDay.alerts.title')}</AppLink>}
    {tasks && <AppLink className={styles.link} to={to('tasks')}>{t('myDay.myTasks')}</AppLink>}
  </nav>;
}

export function MyDaySection({ name, children }: { name: keyof typeof ids; children: ReactNode }) {
  const styles = useStyles();
  return <div id={ids[name]} tabIndex={-1} className={styles.target}>{children}</div>;
}
