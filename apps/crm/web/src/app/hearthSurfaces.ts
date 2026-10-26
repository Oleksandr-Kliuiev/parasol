import { makeStyles, mergeClasses, tokens, type FluentProviderCustomStyleHooks } from '@fluentui/react-components';
import { h } from './hearth';
import { ease } from './motion';

/*
 * Surfaces of the visual system on top of Fluent: pill badges, the segmented tab list with its sliding plate, quiet
 * tables whose rows rise in, and the floating layers (dialogs, menus, lists, popovers, tooltips, notices and toasts).
 * The same custom style hook contract as hearthControls.ts, hence the disabled rule.
 */
/* eslint-disable react-hooks/immutability */

type Slot = { className?: string } | undefined;
type WithRoot = { root: { className?: string } };

const useBadge = makeStyles({
  base: {
    borderRadius: '999px',
    minHeight: '24px',
    height: 'auto',
    paddingTop: '4px',
    paddingBottom: '4px',
    paddingLeft: '10px',
    paddingRight: '10px',
    gap: '6px',
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: tokens.fontWeightSemibold,
    whiteSpace: 'nowrap',
  },
  // Small badges keep the 12 px floor of the visual system; only the padding is tighter.
  small: { minHeight: '20px', paddingTop: '2px', paddingBottom: '2px', paddingLeft: '7px', paddingRight: '7px', fontSize: '12px', lineHeight: '16px', gap: '4px' },
  dot: { '::before': { content: '""', width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0, backgroundColor: 'currentColor' } },
  tintEmber: { backgroundColor: h.emberSoft, color: h.emberT, border: '1px solid transparent', '::before': { backgroundColor: h.ember } },
  tintIris: { backgroundColor: h.irisSoft, color: h.irisT, border: '1px solid transparent', '::before': { backgroundColor: h.iris } },
  tintSpruce: { backgroundColor: h.spruceSoft, color: h.spruceT, border: '1px solid transparent', '::before': { backgroundColor: h.spruce } },
  tintSaffron: { backgroundColor: h.saffronSoft, color: h.saffronT, border: '1px solid transparent', '::before': { backgroundColor: h.saffron } },
  tintNeutral: { backgroundColor: h.well, color: h.muted, border: '1px solid transparent', '::before': { backgroundColor: h.faint } },
  tintInk: { backgroundColor: h.well, color: h.text, border: '1px solid transparent', '::before': { backgroundColor: h.ink } },
  filledEmber: { backgroundColor: '#C2401B', color: '#FFFAF5', border: '1px solid transparent' },
  filledBrand: { backgroundColor: '#C8441D', color: '#FFFAF5', border: '1px solid transparent' },
  filledIris: { backgroundColor: '#4A41C4', color: '#FBFAFF', border: '1px solid transparent' },
  filledSpruce: { backgroundColor: '#0A7A63', color: '#F5FFFB', border: '1px solid transparent' },
  filledSaffron: { backgroundColor: '#C98A12', color: '#1D1915', border: '1px solid transparent' },
  filledInk: { backgroundColor: h.ink, color: h.onInk, border: '1px solid transparent' },
  filledNeutral: { backgroundColor: h.well, color: h.text, border: '1px solid transparent' },
  outline: { backgroundColor: 'transparent', color: h.muted, border: `1px solid ${h.line2}` },
});

type BadgeColor = 'brand' | 'danger' | 'important' | 'informative' | 'severe' | 'subtle' | 'success' | 'warning';
const tintClass: Record<BadgeColor, 'tintEmber' | 'tintIris' | 'tintSpruce' | 'tintSaffron' | 'tintNeutral' | 'tintInk'> = {
  brand: 'tintEmber',
  danger: 'tintEmber',
  severe: 'tintEmber',
  important: 'tintInk',
  informative: 'tintIris',
  subtle: 'tintNeutral',
  success: 'tintSpruce',
  warning: 'tintSaffron',
};
const filledClass: Record<
  BadgeColor,
  'filledEmber' | 'filledBrand' | 'filledIris' | 'filledSpruce' | 'filledSaffron' | 'filledInk' | 'filledNeutral'
> = {
  brand: 'filledBrand',
  danger: 'filledEmber',
  severe: 'filledEmber',
  important: 'filledInk',
  informative: 'filledIris',
  subtle: 'filledNeutral',
  success: 'filledSpruce',
  warning: 'filledSaffron',
};

function useStyleBadge(state: unknown) {
  const s = state as {
    root: { className?: string };
    appearance: 'filled' | 'ghost' | 'outline' | 'tint';
    color: BadgeColor;
    size: string;
    icon?: unknown;
  };
  const styles = useBadge();
  const small = s.size === 'tiny' || s.size === 'extra-small' || s.size === 'small';
  s.root.className = mergeClasses(
    s.root.className,
    styles.base,
    small && styles.small,
    s.appearance === 'tint' && styles[tintClass[s.color] ?? 'tintNeutral'],
    s.appearance === 'tint' && !s.icon && styles.dot,
    s.appearance === 'filled' && styles[filledClass[s.color] ?? 'filledNeutral'],
    s.appearance === 'outline' && styles.outline,
  );
}

/*
 * The segmented control of the reference. The plate under the chosen tab is Fluent's selection indicator (::after)
 * grown to the whole tab, so Fluent's own indicator animation slides it from the previous tab to the new one.
 */
const plate = {
  top: '0',
  bottom: '0',
  left: '0',
  right: '0',
  height: 'auto',
  width: 'auto',
  zIndex: '-1',
  borderRadius: '10px',
  backgroundColor: h.surface,
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06), 0 4px 10px -4px rgba(0, 0, 0, 0.14)',
};

const useTabs = makeStyles({
  list: {
    backgroundColor: h.well,
    borderRadius: '12px',
    padding: '3px',
    gap: '2px',
    width: 'fit-content',
    maxWidth: '100%',
    boxSizing: 'border-box',
  },
  vertical: { width: 'auto' },
  tab: {
    isolation: 'isolate',
    borderRadius: '10px',
    minHeight: '32px',
    paddingTop: '7px',
    paddingBottom: '7px',
    paddingLeft: '13px',
    paddingRight: '13px',
    color: h.muted,
    '::before': { display: 'none' },
    ':hover': { backgroundColor: 'transparent', color: h.text },
    ':hover:active': { backgroundColor: 'transparent' },
  },
  unselected: { '::after': { display: 'none' } },
  selected: {
    color: h.text,
    '::after': plate,
    ':enabled:hover::after': { backgroundColor: h.surface },
    ':enabled:active::after': { backgroundColor: h.surface },
    ':hover': { color: h.text },
  },
  content: { fontSize: '12.5px', lineHeight: '18px', fontWeight: tokens.fontWeightSemibold },
});

// Rows rise in one after another when a list appears (the reference's table entrance); the header stays put.
const rowDelays = Object.fromEntries(
  Array.from({ length: 11 }, (_, index) => [`:nth-child(${index + 2})`, { animationDelay: `${(index + 1) * 30}ms` }]),
);

const useTable = makeStyles({
  table: { fontSize: '13.5px' },
  header: {
    height: '38px',
    fontSize: '12px',
    lineHeight: '16px',
    fontWeight: tokens.fontWeightSemibold,
    color: h.muted,
    paddingLeft: '12px',
    paddingRight: '12px',
    borderBottom: `1px solid ${h.line}`,
    // A fixed-layout table cannot widen a column for its heading: the heading wraps instead of running into the next.
    whiteSpace: 'normal',
    overflowWrap: 'break-word',
  },
  // The row separator is drawn by the cells (an inset shadow), not as a row border: a table paints collapsed borders
  // itself, so a row rising in from transparent would leave its line behind on the empty place.
  cell: { paddingLeft: '12px', paddingRight: '12px', boxShadow: `inset 0 -1px 0 ${h.line}` },
  row: {
    minHeight: '52px',
    borderBottomWidth: 0,
    borderBottomStyle: 'none',
    transitionProperty: 'background-color',
    transitionDuration: '0.15s',
    ':hover': { backgroundColor: h.surface2 },
    ':last-child > td': { boxShadow: 'none' },
  },
  rowRise: {
    animationName: { from: { opacity: 0, transform: 'translateY(8px)' } },
    animationDuration: '0.5s',
    animationTimingFunction: ease.out,
    animationFillMode: 'backwards',
    ...rowDelays,
    ':nth-child(n + 13)': { animationDelay: '360ms' },
  },
  headerRow: { minHeight: '40px', ':hover': { backgroundColor: 'transparent' } },
});

const floating = {
  backgroundColor: h.float,
  border: `1px solid ${h.line}`,
  boxShadow: tokens.shadow16,
};

const useOverlays = makeStyles({
  dialog: {
    ...floating,
    borderRadius: '22px',
    padding: '22px',
    boxShadow: tokens.shadow64,
    '@media (max-width: 480px)': { padding: '20px', borderRadius: '20px' },
    // The search palette brings its own bar and list to the edges.
    '&[data-variant="palette"]': { padding: 0, overflow: 'hidden' },
  },
  // The reference's backdrop: a warm veil with a light blur, darker in the dark theme.
  backdrop: { backgroundColor: h.backdrop, backdropFilter: 'blur(6px)' },
  dialogTitle: { fontFamily: h.display, fontSize: '21px', lineHeight: '28px', fontWeight: tokens.fontWeightSemibold, letterSpacing: '-0.02em' },
  // The buttons of a dialog take the whole width of its foot (Fluent gives them the right half, and long labels wrapped).
  dialogActions: { gap: '10px', paddingTop: '8px', gridColumnStart: 1, gridColumnEnd: 4, justifySelf: 'end', flexWrap: 'wrap', justifyContent: 'flex-end' },
  popover: { ...floating, borderRadius: '16px', padding: '6px' },
  popoverSurface: { ...floating, borderRadius: '16px' },
  menuItem: {
    backgroundColor: 'transparent',
    borderRadius: '10px',
    minHeight: '38px',
    paddingLeft: '12px',
    paddingRight: '12px',
    gap: '10px',
    fontSize: '13.5px',
    fontWeight: tokens.fontWeightMedium,
    ':hover': { backgroundColor: h.well },
    ':hover:active': { backgroundColor: h.line },
  },
  menuHeader: { fontSize: '12px', fontWeight: tokens.fontWeightMedium, color: h.muted },
  menuDivider: { marginTop: '4px', marginBottom: '4px', marginLeft: '6px', marginRight: '6px', backgroundColor: h.line },
  listbox: { ...floating, borderRadius: '14px', padding: '6px' },
  option: {
    borderRadius: '10px',
    minHeight: '36px',
    fontSize: '13.5px',
    fontWeight: tokens.fontWeightMedium,
    ':hover': { backgroundColor: h.well },
    ':hover:active': { backgroundColor: h.line },
  },
  card: { borderRadius: '20px', border: `1px solid ${h.line}`, boxShadow: tokens.shadow4 },
  tooltip: {
    ...floating,
    borderRadius: '10px',
    paddingTop: '6px',
    paddingBottom: '6px',
    paddingLeft: '10px',
    paddingRight: '10px',
    color: h.text,
    fontSize: '12.5px',
    lineHeight: '18px',
    fontWeight: tokens.fontWeightMedium,
  },
});

// Notices in the soft tone of their intent, without a frame: info in the well, the others in their accent.
const useMessage = makeStyles({
  root: {
    // A grid cell (most dialog bodies are grids) would otherwise grow to the one-line text, so Fluent never sees the bar
    // overflow, keeps it on one line and the dialog body scrolls sideways; at 0 it takes the cell's width and wraps.
    minWidth: 0,
    borderRadius: '14px',
    borderTopColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: 'transparent',
    color: h.text,
  },
  info: { backgroundColor: h.well },
  warning: { backgroundColor: h.saffronSoft },
  error: { backgroundColor: h.emberSoft },
  success: { backgroundColor: h.spruceSoft },
  iconInfo: { color: h.irisT },
  iconWarning: { color: h.saffronT },
  iconError: { color: h.emberT },
  iconSuccess: { color: h.spruceT },
  title: { fontWeight: tokens.fontWeightBold },
});

// Toasts of the reference: a dark pill near the bottom edge, white text, the icon in the text colour.
const useToast = makeStyles({
  root: {
    backgroundColor: h.ink,
    color: h.onInk,
    borderRadius: '14px',
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: '14px',
    paddingRight: '12px',
    boxShadow: tokens.shadow64,
    border: 'none',
  },
  title: { color: 'inherit', fontSize: '13.5px', lineHeight: '20px', fontWeight: tokens.fontWeightSemibold },
  media: { color: 'inherit' },
  body: { color: 'inherit', opacity: 0.8, fontSize: '13px' },
});

const useSkeleton = makeStyles({ item: { borderRadius: '8px' } });

export const surfaceStyleHooks: FluentProviderCustomStyleHooks = {
  useBadgeStyles_unstable: (state) => useStyleBadge(state),
  useTabListStyles_unstable: (state) => {
    const s = state as WithRoot & { vertical: boolean };
    const styles = useTabs();
    s.root.className = mergeClasses(s.root.className, styles.list, s.vertical && styles.vertical);
  },
  useTabStyles_unstable: (state) => {
    const s = state as WithRoot & { selected: boolean; content: Slot };
    const styles = useTabs();
    s.root.className = mergeClasses(s.root.className, styles.tab, s.selected ? styles.selected : styles.unselected);
    if (s.content) s.content.className = mergeClasses(s.content.className, styles.content);
  },
  useTableStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useTable().table);
  },
  useTableHeaderCellStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useTable().header);
  },
  useTableCellStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useTable().cell);
  },
  useTableRowStyles_unstable: (state) => {
    const s = state as WithRoot & { isHeaderRow?: boolean };
    const styles = useTable();
    s.root.className = mergeClasses(s.root.className, styles.row, s.isHeaderRow ? styles.headerRow : styles.rowRise);
  },
  useDialogSurfaceStyles_unstable: (state) => {
    const s = state as WithRoot & { backdrop?: Slot };
    const styles = useOverlays();
    s.root.className = mergeClasses(s.root.className, styles.dialog);
    if (s.backdrop) s.backdrop.className = mergeClasses(s.backdrop.className, styles.backdrop);
  },
  useDialogTitleStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().dialogTitle);
  },
  useDialogActionsStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().dialogActions);
  },
  useMenuPopoverStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().popover);
  },
  useMenuItemStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().menuItem);
  },
  useMenuItemRadioStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().menuItem);
  },
  useMenuItemCheckboxStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().menuItem);
  },
  useMenuGroupHeaderStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().menuHeader);
  },
  useMenuDividerStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().menuDivider);
  },
  usePopoverSurfaceStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().popoverSurface);
  },
  useListboxStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().listbox);
  },
  useOptionStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().option);
  },
  useCardStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useOverlays().card);
  },
  useTooltipStyles_unstable: (state) => {
    const s = state as { content: Slot };
    const styles = useOverlays();
    if (s.content) s.content.className = mergeClasses(s.content.className, styles.tooltip);
  },
  useMessageBarStyles_unstable: (state) => {
    const s = state as WithRoot & { intent: 'info' | 'warning' | 'error' | 'success'; icon?: Slot };
    const styles = useMessage();
    const icon = { info: styles.iconInfo, warning: styles.iconWarning, error: styles.iconError, success: styles.iconSuccess }[s.intent];
    s.root.className = mergeClasses(s.root.className, styles.root, styles[s.intent] ?? styles.info);
    if (s.icon) s.icon.className = mergeClasses(s.icon.className, icon);
  },
  useMessageBarTitleStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useMessage().title);
  },
  useToastStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useToast().root);
  },
  useToastTitleStyles_unstable: (state) => {
    const s = state as WithRoot & { media?: Slot };
    const styles = useToast();
    s.root.className = mergeClasses(s.root.className, styles.title);
    if (s.media) s.media.className = mergeClasses(s.media.className, styles.media);
  },
  useToastBodyStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useToast().body);
  },
  useSkeletonItemStyles_unstable: (state) => {
    const s = state as WithRoot;
    s.root.className = mergeClasses(s.root.className, useSkeleton().item);
  },
};
