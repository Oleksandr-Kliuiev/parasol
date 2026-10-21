import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, SearchBox, Spinner, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowRight16Regular, Box16Regular, Building16Regular, ChevronRight16Regular, Dismiss20Regular, Person16Regular, Search20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { api, query } from '../api/client';
import type { SearchHit, SearchResponse } from '../api/types';
import { useDebouncedValue } from '../shared/utils/useDebouncedValue';
import { NARROW_SCREEN, useMediaQuery } from '../shared/utils/useMediaQuery';
import { h } from './hearth';
import { useNavGroups } from './navigation';
import type { SearchTypeAhead } from './searchTypeAhead';
import { searchShortcut } from './shortcut';

const useStyles = makeStyles({
  announce: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
  root: { position: 'relative', flex: 1, minWidth: 0, maxWidth: '480px' },
  inlineRoot: { maxWidth: 'none', display: 'flex', flexDirection: 'column' },
  // The palette of the reference: a borderless 17 px field over a hairline, the results under it, the keys at the foot.
  bar: { display: 'flex', alignItems: 'center', gap: '12px', paddingTop: '14px', paddingBottom: '14px', paddingLeft: '18px', paddingRight: '12px', borderBottom: `1px solid ${h.line}`, color: h.muted },
  field: {
    flex: 1,
    minWidth: 0,
    height: '32px',
    padding: 0,
    border: 'none',
    outline: 'none',
    backgroundColor: 'transparent',
    color: h.text,
    fontFamily: 'inherit',
    fontSize: '17px',
    fontWeight: 500,
    '::placeholder': { color: h.faint },
    '::-webkit-search-cancel-button': { display: 'none' },
  },
  kbd: {
    flexShrink: 0,
    paddingTop: '3px',
    paddingBottom: '3px',
    paddingLeft: '7px',
    paddingRight: '7px',
    borderRadius: '7px',
    border: `1px solid ${h.line2}`,
    color: h.muted,
    fontSize: '11px',
    fontWeight: 700,
    '@media (hover: none)': { display: 'none' },
  },
  inlinePanel: { position: 'static', maxHeight: 'min(52vh, 480px)', boxShadow: 'none', border: 'none', borderRadius: 0, paddingTop: '8px', paddingBottom: '8px', paddingLeft: '8px', paddingRight: '8px', backgroundColor: 'transparent' },
  inlineGroup: { paddingTop: '10px', paddingLeft: '10px', paddingRight: '10px', paddingBottom: '4px', fontSize: '11.5px', fontWeight: 700, letterSpacing: '0.06em' },
  inlineOption: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    paddingTop: '9px',
    paddingBottom: '9px',
    paddingLeft: '10px',
    paddingRight: '10px',
    borderRadius: '12px',
  },
  lead: { display: 'grid', placeItems: 'center', flexShrink: 0, width: '36px', height: '36px', borderRadius: '11px', backgroundColor: h.well, color: h.text },
  text: { display: 'grid', minWidth: 0, flex: 1 },
  inlineSubtitle: { color: h.muted, fontSize: '12px' },
  go: { display: 'inline-flex', flexShrink: 0, color: h.faint },
  // Keyboard hints only where there is a keyboard to use them.
  inlineFooter: { borderTop: `1px solid ${h.line}`, paddingTop: '10px', paddingBottom: '12px', paddingLeft: '18px', paddingRight: '18px', color: h.muted, fontSize: '12px',
    '@media (hover: none) and (pointer: coarse)': { display: 'none' } },
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
  active: { backgroundColor: h.well },
  icon: { color: tokens.colorNeutralForeground3 },
  subtitle: { gridColumn: 2, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  footer: { paddingInline: tokens.spacingHorizontalM, paddingBlock: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 },
});

const icons: Record<string, ReactElement> = {
  organizations: <Building16Regular />,
  contacts: <Person16Regular />,
  products: <Box16Regular />,
  commands: <ArrowRight16Regular />,
};

const MAX_COMMANDS = 5;

/**
 * Header search (FR-GEN-01) and command palette (UX concept §8): grouped results as you type, arrow keys to move, Enter
 * to open, Ctrl/Cmd+K to focus. A "Go to" group lists the menu entries the user may open whose name matches the text.
 */
export function GlobalSearch({ inline = false, onDone, onClose, typeAhead }: { inline?: boolean; onDone?: () => void; onClose?: () => void; typeAhead?: SearchTypeAhead } = {}) {
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
    // The palette opens with the first menu entries, so it is useful before anything is typed.
    if (typed.length < 2 && !(inline && typed.length === 0)) return [];
    return navGroups
      .flatMap((group) => group.items.filter((item) => !item.external).map((item) => ({ item, section: t(`nav.${group.label}`) })))
      .map(({ item, section }) => ({ id: `nav-${item.value}`, title: t(`nav.${item.label}`), subtitle: section, url: item.path }))
      .filter((hit) => typed.length === 0 || hit.title.toLocaleLowerCase(i18n.language).includes(typed))
      .slice(0, typed.length === 0 ? 4 : MAX_COMMANDS);
  }, [navGroups, typed, t, i18n.language, inline]);
  const groups = useMemo(
    () => [...(commands.length > 0 ? [{ group: 'commands', items: commands }] : []), ...(term.length >= 2 ? (data?.groups ?? []) : [])],
    [commands, data, term],
  );
  const items = useMemo(() => groups.flatMap((g) => g.items.map((item) => ({ ...item, group: g.group }))), [groups]);

  useEffect(() => {
    if (!inline) return;
    // The dialog moves focus to its first button once it has mounted; the field takes it back right after.
    inputRef.current?.focus();
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [inline]);
  useEffect(() => () => typeAhead?.release(), [typeAhead]);

  // What was typed while the palette was still loading arrives with the field's focus (searchTypeAhead).
  const takeTypedAhead = () => {
    const typed = typeAhead?.take();
    if (!typed) return;
    setText(typed);
    setOpen(true);
    setActive(-1);
  };

  const go = (url: string) => {
    // The palette starts empty with its next opening; emptying it now would swap its list while it leaves.
    if (!inline) {
      setOpen(false);
      setText('');
      setActive(-1);
    }
    onDone?.();
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
    } else if (event.key === 'Escape' && !inline) {
      setOpen(false);
    }
  };

  const showPanel = (open || inline) && (commands.length > 0 || (term.length >= 2 && (items.length > 0 || (!isFetching && data !== undefined))));
  let index = -1;

  const comboProps = {
    role: 'combobox',
    'aria-label': t('header.search'),
    'aria-expanded': showPanel,
    'aria-controls': listId,
    'aria-autocomplete': 'list' as const,
    'aria-activedescendant': active >= 0 ? `${listId}-${active}` : undefined,
  };

  return (
    <div className={mergeClasses(styles.root, inline && styles.inlineRoot)}>
      {inline ? (
        <div className={styles.bar}>
          <Search20Regular aria-hidden />
          <input
            ref={inputRef}
            type="search"
            className={styles.field}
            value={text}
            placeholder={t('header.search')}
            autoComplete="off"
            spellCheck={false}
            {...comboProps}
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={takeTypedAhead}
            onKeyDown={onKeyDown}
          />
          {isFetching && <Spinner size="extra-tiny" />}
          <kbd className={styles.kbd} aria-hidden>Esc</kbd>
          {onClose && <Button appearance="subtle" size="small" icon={<Dismiss20Regular />} aria-label={t('common.close')} onClick={onClose} />}
        </div>
      ) : (
      <SearchBox
        ref={inputRef}
        className={styles.box}
        value={text}
        placeholder={narrow || inline ? t('header.search') : `${t('header.search')} (${searchShortcut.replace(' ', '+')})`}
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
      )}
      {/* The listbox holds options only; what the search found is announced beside it (WCAG 4.1.3). */}
      <span role="status" className={styles.announce}>
        {showPanel && term.length >= 2 && !isFetching ? (items.length === 0 ? t('search.noResults') : t('search.found', { count: items.length })) : ''}
      </span>
      {showPanel && (
        <div className={mergeClasses(styles.panel, inline && styles.inlinePanel)} id={listId} role="listbox" aria-label={t('header.search')}>
          {groups.map((group) => (
            <div key={group.group} role="group" aria-label={t(`search.groups.${group.group}`, { defaultValue: group.group })}>
              <span className={mergeClasses(styles.groupLabel, inline && styles.inlineGroup)} aria-hidden>
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
                    className={mergeClasses(styles.option, inline && styles.inlineOption, i === active && styles.active)}
                    // Only a moving pointer takes the highlight: results that appear under a resting one must not
                    // move the keyboard's place (Enter then opened the row under the mouse).
                    onMouseMove={() => { if (active !== i) setActive(i); }}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      go(item.url);
                    }}
                  >
                    {inline ? (
                      <>
                        <span className={styles.lead} aria-hidden>
                          {icons[group.group]}
                        </span>
                        <span className={styles.text}>
                          <Text weight="semibold" truncate wrap={false}>
                            {item.title}
                          </Text>
                          {item.subtitle && <span className={styles.inlineSubtitle}>{item.subtitle}</span>}
                        </span>
                        <span className={styles.go} aria-hidden>
                          <ChevronRight16Regular />
                        </span>
                      </>
                    ) : (
                      <>
                        <span className={styles.icon} aria-hidden>
                          {icons[group.group]}
                        </span>
                        <Text weight="semibold" truncate wrap={false}>
                          {item.title}
                        </Text>
                        {item.subtitle && <span className={styles.subtitle}>{item.subtitle}</span>}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {items.length === 0 && <div className={styles.footer}>{t('search.noResults')}</div>}
          {items.length > 0 && !inline && (
            <div className={styles.footer}>
              <Text size={200}>{t('search.enterHint')}</Text>
            </div>
          )}
        </div>
      )}
      {inline && <div className={styles.inlineFooter}>{t('search.enterHint')}</div>}
    </div>
  );
}
