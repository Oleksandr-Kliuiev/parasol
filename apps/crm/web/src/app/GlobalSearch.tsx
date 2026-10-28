import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, SearchBox, Spinner, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  AlertUrgent16Regular, ArrowRight16Regular, Box16Regular, Building16Regular, ChevronRight16Regular, CloudArchive16Regular, Desktop16Regular,
  Dismiss20Regular, Headset16Regular, Person16Regular, Search20Regular,
} from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { api, query } from '../api/client';
import type { SearchHit, SearchResponse } from '../api/types';
import { useCurrentUser } from '../auth/CurrentUserContext';
import { useDebouncedValue } from '../shared/utils/useDebouncedValue';
import { NARROW_SCREEN, useMediaQuery } from '../shared/utils/useMediaQuery';
import { h } from './hearth';
import { useNavGroups } from './navigation';
import { customerGroups, hitWords, searchGroupPermissions } from './searchHits';
import type { SearchTypeAhead } from './searchTypeAhead';
import { searchShortcut } from './shortcut';

const useStyles = makeStyles({
  announce: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0, padding: 0 },
  root: { position: 'relative', flex: 1, minWidth: 0, maxWidth: '480px' },
  inlineRoot: { maxWidth: 'none', display: 'flex', flexDirection: 'column' },
  // The palette of the reference: a borderless 17 px field over a line, the results under it, the keys at the foot. The line is the
  // field's edge, so it takes the field-edge tone (3:1 in both themes, WCAG 1.4.11), not the hairline of cards.
  bar: { display: 'flex', alignItems: 'center', gap: '12px', paddingTop: '14px', paddingBottom: '14px', paddingLeft: '18px', paddingRight: '12px', borderBottom: `1px solid ${h.fieldEdge}`, color: h.muted },
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
  // Where the groups are, under the field: with several groups the lower ones start below the panel's edge.
  jumps: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', paddingTop: '8px', paddingLeft: '12px', paddingRight: '12px' },
  jumpCount: { color: h.muted, fontVariantNumeric: 'tabular-nums' },
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
    // On a phone a state badge beside the words would leave the title a few letters: it goes under them.
    '@media (max-width: 600px)': {
      display: 'grid',
      gridTemplateColumns: '36px minmax(0, 1fr) 16px',
      gridTemplateAreas: '"lead text go" "lead badge go"',
      columnGap: '12px',
    },
  },
  lead: { display: 'grid', placeItems: 'center', flexShrink: 0, width: '36px', height: '36px', borderRadius: '11px', backgroundColor: h.well, color: h.text,
    '@media (max-width: 600px)': { gridArea: 'lead' } },
  text: { display: 'grid', minWidth: 0, flex: 1, '@media (max-width: 600px)': { gridArea: 'text' } },
  // An alert's or a ticket's title is a sentence: two lines before it is cut.
  inlineTitle: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' },
  inlineBadge: { '@media (max-width: 600px)': { gridArea: 'badge', justifySelf: 'start', marginTop: '4px' } },
  inlineSubtitle: { color: h.muted, fontSize: '12px', overflowWrap: 'anywhere' },
  go: { display: 'inline-flex', flexShrink: 0, color: h.faint, '@media (max-width: 600px)': { gridArea: 'go' } },
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
  // The group's name, and on the same line whether it found more than it shows.
  groupHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', columnGap: '12px' },
  more: { textTransform: 'none', letterSpacing: 'normal', fontWeight: 400, fontSize: '12px', color: h.muted },
  option: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) auto',
    columnGap: tokens.spacingHorizontalS,
    alignItems: 'center',
    paddingInline: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalXS,
    cursor: 'pointer',
    color: tokens.colorNeutralForeground1,
  },
  // The hit Enter opens: a soft well, and an ember edge that stands out 3:1 against it in both themes (WCAG 1.4.11, 2.4.7).
  active: { backgroundColor: h.well, boxShadow: `inset 3px 0 0 ${h.ember}` },
  icon: { color: tokens.colorNeutralForeground3 },
  subtitle: { gridColumn: '2 / 4', color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  badge: { flexShrink: 0 },
  footer: { paddingInline: tokens.spacingHorizontalM, paddingBlock: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 },
  inlineEmpty: { paddingTop: '14px', paddingBottom: '14px', paddingLeft: '18px', paddingRight: '18px' },
  scope: { display: 'block', marginTop: '2px', fontSize: '12px', color: h.muted },
  failed: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', paddingTop: '10px', paddingBottom: '10px', paddingLeft: '18px', paddingRight: '18px', color: h.emberT },
});

const icons: Record<string, ReactElement> = {
  organizations: <Building16Regular />,
  contacts: <Person16Regular />,
  devices: <Desktop16Regular />,
  alerts: <AlertUrgent16Regular />,
  tickets: <Headset16Regular />,
  backup: <CloudArchive16Regular />,
  products: <Box16Regular />,
  commands: <ArrowRight16Regular />,
};

const MAX_COMMANDS = 5;
const TAKE = 6;

const searchFor = async (q: string, signal?: AbortSignal) => (await api.get<SearchResponse>(`/api/v1/search${query({ q, take: TAKE })}`, signal)).data;

/**
 * Header search (FR-GEN-01) and command palette (UX concept §8): grouped results as you type, Ctrl/Cmd+K to focus. The first hit of
 * the answer is the one Enter opens until the keys or the pointer choose another; arrow keys move, Page Up and Page Down go from group
 * to group, and Enter pressed before the answer opens its first hit once it is there. A "Go to" group lists the menu entries the
 * user may open whose name matches the text. Besides customers, contacts and products it finds the operations records — devices,
 * alerts, saved tickets, the people and sites in backups — worded in the reader's language (searchHits.ts).
 */
export function GlobalSearch({ inline = false, onDone, onClose, typeAhead }: { inline?: boolean; onDone?: () => void; onClose?: () => void; typeAhead?: SearchTypeAhead } = {}) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  // The hit the keys or the pointer chose, for the answer it was chosen in: a newer answer never inherits it by its position.
  const [choice, setChoice] = useState<{ query: string | undefined; index: number } | null>(null);
  const term = useDebouncedValue(text.trim(), 250);
  const narrow = useMediaQuery(NARROW_SCREEN);

  const { data, isFetching, isPlaceholderData, error, refetch } = useQuery({
    queryKey: ['search', term],
    enabled: term.length >= 2,
    staleTime: 15_000,
    // The hits of the last search stay while the next is read, so the list does not jump at every pause in typing.
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => searchFor(term, signal),
  });

  const navGroups = useNavGroups();
  const typedText = text.trim();
  const typed = typedText.toLocaleLowerCase(i18n.language);
  const commands = useMemo<SearchHit[]>(() => {
    // The palette opens with the first menu entries, so it is useful before anything is typed.
    if (typed.length < 2 && !(inline && typed.length === 0)) return [];
    return navGroups
      .flatMap((group) => group.items.filter((item) => !item.external).map((item) => ({ item, section: t(`nav.${group.label}`) })))
      .map(({ item, section }) => ({ id: `nav-${item.value}`, title: t(`nav.${item.label}`), subtitle: section, url: item.path }))
      .filter((hit) => typed.length === 0 || hit.title.toLocaleLowerCase(i18n.language).includes(typed))
      .slice(0, typed.length === 0 ? 4 : MAX_COMMANDS);
  }, [navGroups, typed, t, i18n.language, inline]);
  const found = useMemo(() => (term.length >= 2 ? (data?.groups ?? []) : []), [data, term]);
  const groups = useMemo(() => [...(commands.length > 0 ? [{ group: 'commands', items: commands, more: false }] : []), ...found], [commands, found]);
  const items = useMemo(() => groups.flatMap((g) => g.items.map((item) => ({ ...item, group: g.group }))), [groups]);
  // Where each group starts in the list of options, for Page Up and Page Down and the group buttons.
  const starts = useMemo(() => {
    const list: number[] = [];
    let at = 0;
    for (const g of groups) {
      list.push(at);
      at += g.items.length;
    }
    return list;
  }, [groups]);
  // What a search that found nothing looked in: the groups this person may search, in the order they are listed.
  const scope = useMemo(() => {
    const areas = Object.entries(searchGroupPermissions)
      .filter(([, permission]) => user.permissions.includes(permission))
      .map(([group]) => (group === 'alerts' ? t('search.openAlerts') : t(`search.groups.${group}`).toLocaleLowerCase(i18n.language)));
    return areas.length > 0 ? t('search.scope', { areas: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(areas) }) : null;
  }, [user.permissions, t, i18n.language]);

  // The answer on screen is the one for the text as typed now, not the last search's kept while the next is read.
  const answered = typedText.length >= 2 && term === typedText && data !== undefined && !isPlaceholderData;
  const shownQuery = data?.query;
  const current = choice && choice.query === shownQuery && choice.index < items.length ? choice.index : answered && items.length > 0 ? 0 : -1;

  useEffect(() => {
    if (!inline) return;
    // The dialog moves focus to its first button once it has mounted; the field takes it back right after.
    inputRef.current?.focus();
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [inline]);
  useEffect(() => () => typeAhead?.release(), [typeAhead]);

  const retype = (value: string) => {
    setText(value);
    setOpen(true);
    setChoice(null);
  };

  // What was typed while the palette was still loading arrives with the field's focus (searchTypeAhead).
  const takeTypedAhead = () => {
    const typed = typeAhead?.take();
    if (typed) retype(typed);
  };

  const go = (url: string) => {
    // The palette starts empty with its next opening; emptying it now would swap its list while it leaves.
    if (!inline) {
      setOpen(false);
      setText('');
      setChoice(null);
    }
    onDone?.();
    navigate(url);
  };

  // A hit opens on click, never on the press (WCAG 2.5.2); with Ctrl/Cmd or the middle button in a new tab, and the palette stays.
  const openHit = (url: string, event: MouseEvent, newTab = event.ctrlKey || event.metaKey) => {
    if (newTab) window.open(url, '_blank', 'noopener');
    else go(url);
  };

  // Enter before the answer to what was typed has come: its first hit opens once it is there, unless the text changed meanwhile.
  const openFirst = async (asked: string) => {
    if (asked.length < 2) return;
    if (commands[0]) {
      go(commands[0].url);
      return;
    }
    try {
      const answer = await queryClient.fetchQuery({ queryKey: ['search', asked], queryFn: ({ signal }) => searchFor(asked, signal), staleTime: 15_000 });
      const first = answer.groups[0]?.items[0];
      if (first && inputRef.current?.value.trim() === asked) go(first.url);
    } catch {
      // A failed search says so where its hits would be.
    }
  };

  // The keys move the highlight and keep it in view: with several groups the list is taller than the panel. A move to the first
  // option of a group shows the group's name with it.
  const move = (next: number) => {
    setOpen(true);
    setChoice({ query: shownQuery, index: next });
    const option = next >= 0 ? document.getElementById(`${listId}-${next}`) : null;
    (starts.includes(next) ? option?.parentElement : option)?.scrollIntoView?.({ block: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && items.length > 0) {
      event.preventDefault();
      move(Math.min(current + 1, items.length - 1));
    } else if (event.key === 'ArrowUp' && items.length > 0) {
      event.preventDefault();
      move(Math.max(current - 1, 0));
    } else if (event.key === 'PageDown' && items.length > 0) {
      event.preventDefault();
      move(starts.find((start) => start > current) ?? current);
    } else if (event.key === 'PageUp' && items.length > 0) {
      event.preventDefault();
      move(starts.findLast((start) => start < current) ?? Math.max(current, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = items[current];
      if (selected) go(selected.url);
      else void openFirst(typedText);
    } else if (event.key === 'Escape' && !inline) {
      setOpen(false);
    }
  };

  const failed = term.length >= 2 && !isFetching && error != null;
  const visible = open || inline;
  const showList = visible && items.length > 0;
  const showEmpty = visible && answered && items.length === 0 && !failed;
  // Rows a newer search has not answered yet stay in place, so a click still lands where it was aimed; the list says it is busy.
  const stale = isPlaceholderData && isFetching;
  // The groups the search found, as buttons under the field once there are two or more of them.
  const jumps = inline && found.length > 1 ? found.map((group) => ({ group, start: starts[groups.indexOf(group)] ?? 0 })) : [];
  let index = -1;

  const comboProps = {
    role: 'combobox',
    'aria-label': t('header.search'),
    'aria-expanded': showList,
    'aria-controls': listId,
    'aria-autocomplete': 'list' as const,
    'aria-activedescendant': showList && current >= 0 ? `${listId}-${current}` : undefined,
  };

  const groupName = (group: string) => t(`search.groups.${group}`, { defaultValue: group });
  const moreNote = (group: { group: string; items: SearchHit[] }) =>
    t(customerGroups.has(group.group) ? 'search.moreOfCustomer' : 'search.more', { count: group.items.length });

  const list = showList && (
    <div className={inline ? mergeClasses(styles.panel, styles.inlinePanel) : undefined} id={listId} role="listbox" aria-label={t('header.search')}
      aria-busy={stale || undefined}>
      {groups.map((group) => {
        const label = groupName(group.group);
        const labelId = `${listId}-${group.group}`;
        return (
          <div key={group.group} role="group" aria-label={group.more ? `${label}, ${moreNote(group)}` : label}>
            <div className={mergeClasses(styles.groupLabel, inline && styles.inlineGroup, styles.groupHead)} aria-hidden>
              {/* Each hit names its group in its description: screen readers that skip the group's name still say what it is. */}
              <span id={labelId}>{label}</span>
              {group.more && <span className={styles.more}>{moreNote(group)}</span>}
            </div>
            {group.items.map((item) => {
              index += 1;
              const i = index;
              const words = hitWords(t, group.group, item);
              const badge = words.badge && (
                <Badge appearance="tint" size="small" color={words.badge.color} className={mergeClasses(styles.badge, inline && styles.inlineBadge)}>
                  {words.badge.text}
                </Badge>
              );
              return (
                <div
                  key={`${group.group}-${item.id}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === current}
                  aria-describedby={labelId}
                  className={mergeClasses(styles.option, inline && styles.inlineOption, i === current && styles.active)}
                  // Only a moving pointer takes the highlight: results that appear under a resting one must not
                  // move the keyboard's place (Enter then opened the row under the mouse).
                  onMouseMove={() => { if (current !== i) setChoice({ query: shownQuery, index: i }); }}
                  // The press keeps focus in the field; the click opens.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => openHit(item.url, event)}
                  onAuxClick={(event) => { if (event.button === 1) openHit(item.url, event, true); }}
                >
                  {inline ? (
                    <>
                      <span className={styles.lead} aria-hidden>
                        {icons[group.group]}
                      </span>
                      <span className={styles.text}>
                        <Text weight="semibold" className={styles.inlineTitle}>
                          {words.title}
                        </Text>
                        {words.subtitle && <span className={styles.inlineSubtitle}>{words.subtitle}</span>}
                      </span>
                      {badge}
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
                        {words.title}
                      </Text>
                      {badge ?? <span />}
                      {words.subtitle && <span className={styles.subtitle}>{words.subtitle}</span>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
  // A search that found nothing says so outside the list, which holds options only, and names where it looked.
  const empty = showEmpty && (
    <div className={mergeClasses(styles.footer, inline && styles.inlineEmpty)}>
      <span>{t('search.noResults')}</span>
      {scope && <span className={styles.scope}>{scope}</span>}
    </div>
  );
  // A search that failed says so where its hits would be; asking again keeps focus in the field, as the button goes while it reads.
  const failure = failed && visible && (
    <div className={styles.failed} role="alert">
      <span>{t('search.failed')}</span>
      <Button size="small" onClick={() => { inputRef.current?.focus(); void refetch(); }}>{t('common.retry')}</Button>
    </div>
  );

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
            onChange={(event) => retype(event.target.value)}
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
        {...comboProps}
        contentAfter={isFetching ? <Spinner size="extra-tiny" /> : undefined}
        onChange={(_, d) => retype(d.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      )}
      {/* The listbox holds options only; what the search found is announced beside it (WCAG 4.1.3). */}
      <span role="status" className={styles.announce}>
        {visible && answered && !isFetching ? (items.length === 0 ? [t('search.noResults'), scope].filter(Boolean).join(' ') : t('search.found', { count: items.length })) : ''}
      </span>
      {inline ? (
        <>
          {failure}
          {jumps.length > 0 && (
            <div className={styles.jumps} role="group" aria-label={t('search.jumpLabel')}>
              {jumps.map(({ group, start }) => (
                // The press keeps focus in the field, so Enter opens the hit the button chose.
                <Button key={group.group} size="small" appearance="subtle" onMouseDown={(event) => event.preventDefault()}
                  onClick={() => { move(start); inputRef.current?.focus(); }}>
                  {groupName(group.group)}{' '}
                  <span className={styles.jumpCount}>{group.more ? `${group.items.length}+` : group.items.length}</span>
                </Button>
              ))}
            </div>
          )}
          {list}
          {empty}
          <div className={styles.inlineFooter}>{t('search.enterHint')}</div>
        </>
      ) : (
        (failure || list || empty) && (
          <div className={styles.panel}>
            {failure}
            {list}
            {empty}
            {showList && (
              <div className={styles.footer}>
                <Text size={200}>{t('search.enterHint')}</Text>
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}
