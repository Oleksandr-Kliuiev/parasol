import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { SearchBox, Spinner, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowRight16Regular, Building16Regular, Person16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { api, query } from '../api/client';
import type { SearchHit, SearchResponse } from '../api/types';
import { useDebouncedValue } from '../shared/utils/useDebouncedValue';
import { NARROW_SCREEN, useMediaQuery } from '../shared/utils/useMediaQuery';
import { useNavGroups } from './navigation';

const useStyles = makeStyles({
  root: { position: 'relative', flex: 1, minWidth: 0, maxWidth: '480px' },
  box: { width: '100%', minWidth: 0, maxWidth: 'none' },
  panel: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    right: 0,
    zIndex: 20,
    maxHeight: '70vh',
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow16,
    paddingBlock: tokens.spacingVerticalXS,
  },
  groupLabel: {
    display: 'block',
    paddingInline: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalXXS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  option: {
    display: 'grid',
    gridTemplateColumns: '16px 1fr',
    columnGap: tokens.spacingHorizontalS,
    alignItems: 'center',
    paddingInline: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalXS,
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
  },
  active: { backgroundColor: tokens.colorNeutralBackground1Selected },
  icon: { color: tokens.colorNeutralForeground3 },
  subtitle: { gridColumn: 2, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  footer: { paddingInline: tokens.spacingHorizontalM, paddingBlock: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 },
});

const icons: Record<string, ReactElement> = {
  organizations: <Building16Regular />,
  contacts: <Person16Regular />,
  commands: <ArrowRight16Regular />,
};

const MAX_COMMANDS = 5;

/**
 * Header search (FR-GEN-01) and command palette (UX concept §8): grouped results as you type, arrow keys to move, Enter
 * to open, Ctrl/Cmd+K to focus. A "Go to" group lists the menu entries the user may open whose name matches the text.
 */
export function GlobalSearch() {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const term = useDebouncedValue(text.trim(), 250);
  const narrow = useMediaQuery(NARROW_SCREEN);

  const { data, isFetching } = useQuery({
    queryKey: ['search', term],
    enabled: term.length >= 2,
    staleTime: 15_000,
    queryFn: async ({ signal }) => (await api.get<SearchResponse>(`/api/v1/search${query({ q: term, take: 6 })}`, signal)).data,
  });

  const navGroups = useNavGroups();
  const typed = text.trim().toLocaleLowerCase(i18n.language);
  const commands = useMemo<SearchHit[]>(() => {
    if (typed.length < 2) return [];
    return navGroups
      .flatMap((group) => group.items.filter((item) => !item.external).map((item) => ({ item, section: t(`nav.${group.label}`) })))
      .map(({ item, section }) => ({ id: `nav-${item.value}`, title: t(`nav.${item.label}`), subtitle: section, url: item.path }))
      .filter((hit) => hit.title.toLocaleLowerCase(i18n.language).includes(typed))
      .slice(0, MAX_COMMANDS);
  }, [navGroups, typed, t, i18n.language]);
  const groups = useMemo(
    () => [...(commands.length > 0 ? [{ group: 'commands', items: commands }] : []), ...(term.length >= 2 ? (data?.groups ?? []) : [])],
    [commands, data, term],
  );
  const items = useMemo(() => groups.flatMap((g) => g.items.map((item) => ({ ...item, group: g.group }))), [groups]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (url: string) => {
    setOpen(false);
    setText('');
    setActive(-1);
    navigate(url);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = items[active];
      if (selected) go(selected.url);
      else if (text.trim()) go(`/organizations?search=${encodeURIComponent(text.trim())}`);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  const showPanel = open && (commands.length > 0 || (term.length >= 2 && (items.length > 0 || (!isFetching && data !== undefined))));
  let index = -1;

  return (
    <div className={styles.root}>
      <SearchBox
        ref={inputRef}
        className={styles.box}
        value={text}
        placeholder={narrow ? t('header.search') : `${t('header.search')} (Ctrl+K)`}
        aria-label={t('header.search')}
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        contentAfter={isFetching ? <Spinner size="extra-tiny" /> : undefined}
        onChange={(_, d) => {
          setText(d.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {showPanel && (
        <div className={styles.panel} id={listId} role="listbox" aria-label={t('header.search')}>
          {groups.map((group) => (
            <div key={group.group} role="group" aria-label={t(`search.groups.${group.group}`, { defaultValue: group.group })}>
              <span className={styles.groupLabel} aria-hidden>
                {t(`search.groups.${group.group}`, { defaultValue: group.group })}
              </span>
              {group.items.map((item) => {
                index += 1;
                const i = index;
                return (
                  <div
                    key={`${group.group}-${item.id}`}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={mergeClasses(styles.option, i === active && styles.active)}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      go(item.url);
                    }}
                  >
                    <span className={styles.icon} aria-hidden>
                      {icons[group.group]}
                    </span>
                    <Text weight="semibold" truncate wrap={false}>
                      {item.title}
                    </Text>
                    {item.subtitle && <span className={styles.subtitle}>{item.subtitle}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {items.length === 0 && <div className={styles.footer}>{t('search.noResults')}</div>}
          {items.length > 0 && (
            <div className={styles.footer}>
              <Text size={200}>{t('search.enterHint')}</Text>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
