import { useContext } from 'react';
import { makeStyles, mergeClasses, tokens, type FluentProviderCustomStyleHooks } from '@fluentui/react-components';
import { CompactControls } from './compactControls';
import { emberFill, h } from './hearth';
import { ease } from './motion';

/*
 * Controls of the visual system on top of Fluent: buttons, fields, switches, checkboxes, radios and links, measured on
 * the reference (42 px controls, 36 px small, 12 px corners, a hairline border and an ember focus ring). A custom style
 * hook receives the component's state and adds class names to its slots, as Fluent's own style hooks do: that is the
 * hook contract, hence the disabled rule.
 */
/* eslint-disable react-hooks/immutability */

type Slot = { className?: string } | undefined;

/** The four border colours as longhands: a Griffel shorthand does not override Fluent's per-side colours. */
const edges = (color: string) => ({ borderTopColor: color, borderRightColor: color, borderBottomColor: color, borderLeftColor: color });
const focusRing = { ...edges(h.ember), boxShadow: `0 0 0 3px ${h.emberSoft}` };
// The theme's error edge (Fluent's invalid border, the same tone as --h-bad): at least 4.5:1 on the field and on the
// card, dialog, page, footer and well surfaces in both themes (WCAG 1.4.11 asks for 3:1).
const invalidEdge = edges(tokens.colorPaletteRedBorder2);

/** Fluent's Field marks the control (input, textarea, select or a dropdown's button) with aria-invalid on an error. */
const isInvalid = (slot: { 'aria-invalid'?: unknown } | undefined) => `${slot?.['aria-invalid']}` === 'true';

const useButton = makeStyles({
  base: {
    minWidth: 'auto',
    gap: '8px',
    // A button label stays on one line (the reference's buttons never wrap); a row of buttons wraps instead.
    whiteSpace: 'nowrap',
    fontWeight: tokens.fontWeightSemibold,
    transitionProperty: 'background-color, border-color, box-shadow, filter, translate, transform',
    transitionDuration: `0.15s, 0.15s, 0.15s, 0.15s, 0.5s, 0.15s`,
    transitionTimingFunction: `ease, ease, ease, ease, ${ease.out}, ease`,
    // A press you can feel on touch screens (the reference shrinks the button a little).
    '@media (hover: none)': { ':active': { transform: 'scale(0.97)' } },
  },
  medium: { minHeight: '42px', paddingLeft: '16px', paddingRight: '16px', borderRadius: '12px', fontSize: '13.5px' },
  small: { minHeight: '36px', paddingLeft: '13px', paddingRight: '13px', borderRadius: '10px', fontSize: '12.5px' },
  large: { minHeight: '48px', paddingLeft: '20px', paddingRight: '20px', borderRadius: '14px', fontSize: '14px' },
  iconMedium: { width: '40px', minWidth: '40px', maxWidth: '40px', minHeight: '40px', paddingLeft: 0, paddingRight: 0 },
  iconSmall: { width: '32px', minWidth: '32px', maxWidth: '32px', minHeight: '32px', paddingLeft: 0, paddingRight: 0 },
  primary: {
    ...emberFill,
    border: '1px solid transparent',
    ':hover': { ...emberFill, filter: 'brightness(1.06)', border: '1px solid transparent' },
    ':hover:active': { ...emberFill, filter: 'brightness(0.96)', border: '1px solid transparent' },
  },
  secondary: {
    backgroundColor: h.surface,
    color: h.text,
    border: `1px solid ${h.line2}`,
    ':hover': { backgroundColor: h.surface2, color: h.text, border: `1px solid ${h.line2}` },
    ':hover:active': { backgroundColor: h.surface2, color: h.text, border: `1px solid ${h.line2}` },
  },
  // Icon buttons carry the lighter hairline of the reference; the border darkens on hover.
  secondaryIcon: { border: `1px solid ${h.line}`, ':hover': { border: `1px solid ${h.line2}` } },
  subtle: {
    ':hover': { backgroundColor: h.well, color: h.text },
    ':hover:active': { backgroundColor: h.line, color: h.text },
  },
  checked: {
    backgroundColor: h.ink,
    color: h.onInk,
    border: '1px solid transparent',
    ':hover': { backgroundColor: h.ink, color: h.onInk, filter: 'brightness(1.15)' },
    ':hover:active': { backgroundColor: h.ink, color: h.onInk },
  },
  // Disabled keeps its look at 45 %, as in the reference, instead of Fluent's grey slab.
  disabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
    boxShadow: 'none',
    ':hover': { filter: 'none', cursor: 'not-allowed' },
    ':hover:active': { filter: 'none' },
  },
  primaryDisabled: {
    ...emberFill,
    boxShadow: 'none',
    border: '1px solid transparent',
    ':hover': { ...emberFill, boxShadow: 'none', border: '1px solid transparent' },
    ':hover:active': { ...emberFill, boxShadow: 'none', border: '1px solid transparent' },
  },
  secondaryDisabled: {
    backgroundColor: h.surface,
    color: h.text,
    border: `1px solid ${h.line2}`,
    ':hover': { backgroundColor: h.surface, color: h.text, border: `1px solid ${h.line2}` },
    ':hover:active': { backgroundColor: h.surface, color: h.text, border: `1px solid ${h.line2}` },
  },
  subtleDisabled: {
    backgroundColor: 'transparent',
    color: h.text,
    ':hover': { backgroundColor: 'transparent', color: h.text },
    ':hover:active': { backgroundColor: 'transparent', color: h.text },
  },
});

function useStyleButton(state: unknown, toggle: boolean) {
  const s = state as {
    root: { className?: string };
    appearance: string;
    size: 'small' | 'medium' | 'large';
    iconOnly: boolean;
    disabled?: boolean;
    disabledFocusable?: boolean;
    checked?: boolean;
  };
  // Hooks run on every render of the component, so these are stable hook calls.
  const styles = useButton();
  const compact = useContext(CompactControls);
  const size = compact && s.size === 'medium' ? 'small' : s.size;
  const disabled = Boolean(s.disabled || s.disabledFocusable);
  const secondary = s.appearance === 'secondary' || s.appearance === 'outline';
  const subtle = s.appearance === 'subtle' || s.appearance === 'transparent';
  s.root.className = mergeClasses(
    s.root.className,
    styles.base,
    styles[size],
    s.iconOnly && (size === 'small' ? styles.iconSmall : size === 'medium' && styles.iconMedium),
    !disabled && s.appearance === 'primary' && styles.primary,
    !disabled && secondary && styles.secondary,
    !disabled && secondary && s.iconOnly && styles.secondaryIcon,
    !disabled && subtle && styles.subtle,
    !disabled && toggle && s.checked && styles.checked,
    disabled && styles.disabled,
    disabled && s.appearance === 'primary' && styles.primaryDisabled,
    disabled && secondary && styles.secondaryDisabled,
    disabled && subtle && styles.subtleDisabled,
  );
}

/*
 * Fields: one hairline all round, ember border and a soft ring on focus. Fluent draws a darker bottom edge and a bottom
 * focus line, and its ":active,:focus-within" rule sits later in the style sheet than ":focus-within": the focus rule
 * therefore repeats the pseudo-class to win on specificity, and ":active" is reset as well. Never only the bottom edge.
 */
const useField = makeStyles({
  control: {
    minHeight: '42px',
    borderRadius: '12px',
    borderTopWidth: '1px',
    borderRightWidth: '1px',
    borderBottomWidth: '1px',
    borderLeftWidth: '1px',
    borderTopStyle: 'solid',
    borderRightStyle: 'solid',
    borderBottomStyle: 'solid',
    borderLeftStyle: 'solid',
    ...edges(h.fieldEdge),
    backgroundColor: h.surface,
    transitionProperty: 'border-color, box-shadow',
    transitionDuration: '0.15s',
    '::after': { display: 'none' },
    '::before': { display: 'none' },
    ':hover': edges(h.fieldEdgeHover),
    ':active': edges(h.fieldEdgeHover),
    ':focus-within:focus-within': { ...focusRing, outline: '2px solid transparent' },
  },
  // The text box never asks for more room than its column: an input's own width (its size attribute) would push a field
  // with a suffix ("days", "h") past the edge of a narrow grid column.
  inputSlot: { width: 0, minWidth: 0 },
  small: { minHeight: '36px', borderRadius: '10px' },
  textarea: { minHeight: 'auto' },
  // A long text is seen whole: the box grows with what is written (field-sizing, Baseline 2026) up to a height where it
  // scrolls, and never starts smaller than three lines.
  textareaSlot: { fieldSizing: 'content', minHeight: '72px', maxHeight: '320px' },
  disabled: { opacity: 0.55, ':hover': edges(h.line2), ':active': edges(h.line2) },
  // An error keeps the red edge at rest, under the pointer and while pressed, disabled or not, so the edge goes with the
  // message under the field; the ember ring still wins on focus (the focus rule's doubled pseudo-class outranks these).
  // Fluent's own invalid border is not enough: SpinButton draws it on the '::before' hidden above, and most fields drop
  // it when disabled.
  invalid: { ...invalidEdge, ':hover': invalidEdge, ':active': invalidEdge },
  select: {
    minHeight: '42px',
    height: '42px',
    borderRadius: '12px',
    borderTopWidth: '1px',
    borderRightWidth: '1px',
    borderBottomWidth: '1px',
    borderLeftWidth: '1px',
    borderTopStyle: 'solid',
    borderRightStyle: 'solid',
    borderBottomStyle: 'solid',
    borderLeftStyle: 'solid',
    ...edges(h.fieldEdge),
    backgroundColor: h.surface,
    fontWeight: tokens.fontWeightMedium,
    ':hover': edges(h.fieldEdgeHover),
    ':active': edges(h.fieldEdgeHover),
    ':focus:focus': { ...focusRing, outline: '2px solid transparent' },
  },
  selectSmall: { minHeight: '36px', height: '36px', borderRadius: '10px' },
  selectRoot: { '::after': { display: 'none' } },
  // Field label and help text of the reference: 12.5 px bold label, 6 px to the control, quiet help under it.
  field: { rowGap: '6px' },
  label: { paddingTop: 0, paddingBottom: 0, marginBottom: 0, fontSize: '12.5px', lineHeight: '18px', fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground2 },
  hint: { marginTop: 0, fontSize: '12px', lineHeight: '17px', color: h.muted },
  validation: { marginTop: 0 },
  // The open/close chevron of a combobox is its own click target: at least 24 × 24 (WCAG 2.5.8).
  expandIcon: { minWidth: '24px', minHeight: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: h.muted },
  // So is the clear button of a search box, which Fluent draws as a bare 20 px icon.
  dismiss: { minWidth: '24px', minHeight: '24px', alignItems: 'center', justifyContent: 'center' },
});

function useStyleControl(state: unknown, kind: 'input' | 'textarea' | 'picker' = 'input') {
  const s = state as {
    root: { className?: string };
    size?: string;
    appearance?: string;
    disabled?: boolean;
    input?: { disabled?: boolean; className?: string; 'aria-invalid'?: unknown };
    textarea?: { disabled?: boolean; className?: string; 'aria-invalid'?: unknown };
    button?: { 'aria-invalid'?: unknown };
  };
  const styles = useField();
  if (s.appearance && s.appearance !== 'outline') return;
  const disabled = Boolean(s.disabled || s.input?.disabled || s.textarea?.disabled);
  if (kind === 'input' && s.input) s.input.className = mergeClasses(s.input.className, styles.inputSlot);
  if (kind === 'textarea' && s.textarea) s.textarea.className = mergeClasses(s.textarea.className, styles.textareaSlot);
  s.root.className = mergeClasses(
    s.root.className,
    styles.control,
    s.size === 'small' && styles.small,
    kind === 'textarea' && styles.textarea,
    disabled && styles.disabled,
    isInvalid(s.input ?? s.textarea ?? s.button) && styles.invalid,
  );
}

/*
 * The switch of the reference: a 44 × 26 track, a white 20 px knob that slides, spruce when on (the compound brand
 * colours of the theme). Fluent's own knob is an icon; it is hidden and the knob drawn here so it can be sized.
 */
const useSwitch = makeStyles({
  root: { alignItems: 'center' },
  indicator: {
    position: 'relative',
    width: '44px',
    height: '26px',
    borderTopWidth: 0,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderLeftWidth: 0,
    borderRadius: '999px',
    marginLeft: 0,
    backgroundColor: h.line2,
    '> *': { visibility: 'hidden' },
    '::after': {
      content: '""',
      position: 'absolute',
      top: '3px',
      left: '3px',
      width: '20px',
      height: '20px',
      borderRadius: '50%',
      backgroundColor: '#FFFFFF',
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)',
      transitionProperty: 'transform',
      transitionDuration: '0.3s',
      transitionTimingFunction: ease.out,
    },
  },
  input: {
    width: 'calc(44px + 8px)',
    ':checked ~ .fui-Switch__indicator::after': { transform: 'translateX(18px)' },
    ':enabled:not(:checked):hover ~ .fui-Switch__indicator': { backgroundColor: tokens.colorNeutralStroke1Hover },
  },
  label: { paddingTop: '4px', paddingBottom: '4px' },
  // A switched-off control: the track fades, the label stays readable (it may say why).
  disabled: { '& .fui-Switch__indicator': { opacity: 0.5 } },
});

// Checkbox and radio at 20 px (the reference's size) with a 7 px corner on the box.
const useChoice = makeStyles({
  box: { marginLeft: 0, width: '20px', height: '20px', fontSize: '14px', borderRadius: '7px', borderTopWidth: '1.5px', borderRightWidth: '1.5px', borderBottomWidth: '1.5px', borderLeftWidth: '1.5px' },
  boxInput: { width: 'calc(20px + 8px)' },
  circle: { marginLeft: 0, width: '20px', height: '20px', borderTopWidth: '1.5px', borderRightWidth: '1.5px', borderBottomWidth: '1.5px', borderLeftWidth: '1.5px', '::after': { width: '20px', height: '20px' } },
  label: { marginTop: 0, marginBottom: 0 },
});

// Links of the reference: ember text in bold, underlined 3 px below on hover.
// Keyboard focus is the ember ring of every other control, not Fluent's double underline.
const useLink = makeStyles({
  root: {
    fontWeight: tokens.fontWeightSemibold,
    textUnderlineOffset: '3px',
    ':hover': { textUnderlineOffset: '3px' },
    ':focus-visible': {
      textDecorationLine: 'none',
      textDecorationStyle: 'solid',
      outlineStyle: 'solid',
      outlineWidth: '2px',
      outlineColor: tokens.colorStrokeFocus2,
      outlineOffset: '2px',
      borderRadius: '4px',
    },
  },
});

export const controlStyleHooks: FluentProviderCustomStyleHooks = {
  useButtonStyles_unstable: (state) => useStyleButton(state, false),
  useToggleButtonStyles_unstable: (state) => useStyleButton(state, true),
  useMenuButtonStyles_unstable: (state) => useStyleButton(state, false),
  useInputStyles_unstable: (state) => useStyleControl(state),
  // SearchBox runs Input's style hook directly, not the custom one, so it needs its own entry.
  useSearchBoxStyles_unstable: (state) => {
    useStyleControl(state);
    const s = state as { dismiss?: Slot };
    const styles = useField();
    if (s.dismiss) s.dismiss.className = mergeClasses(s.dismiss.className, styles.dismiss);
  },
  useComboboxStyles_unstable: (state) => {
    useStyleControl(state, 'picker');
    const s = state as { expandIcon?: Slot };
    const styles = useField();
    if (s.expandIcon) s.expandIcon.className = mergeClasses(s.expandIcon.className, styles.expandIcon);
  },
  useDropdownStyles_unstable: (state) => {
    useStyleControl(state, 'picker');
    const s = state as { expandIcon?: Slot };
    const styles = useField();
    if (s.expandIcon) s.expandIcon.className = mergeClasses(s.expandIcon.className, styles.expandIcon);
  },
  useSpinButtonStyles_unstable: (state) => useStyleControl(state),
  useTextareaStyles_unstable: (state) => useStyleControl(state, 'textarea'),
  useSelectStyles_unstable: (state) => {
    const s = state as { root: { className?: string }; select: { className?: string; 'aria-invalid'?: unknown }; size?: string; appearance?: string };
    const styles = useField();
    if (s.appearance && s.appearance !== 'outline') return;
    s.root.className = mergeClasses(s.root.className, styles.selectRoot);
    s.select.className = mergeClasses(s.select.className, styles.select, s.size === 'small' && styles.selectSmall, isInvalid(s.select) && styles.invalid);
  },
  useFieldStyles_unstable: (state) => {
    const s = state as { root: { className?: string }; label?: Slot; hint?: Slot; validationMessage?: Slot };
    const styles = useField();
    s.root.className = mergeClasses(s.root.className, styles.field);
    if (s.label) s.label.className = mergeClasses(s.label.className, styles.label);
    if (s.hint) s.hint.className = mergeClasses(s.hint.className, styles.hint);
    if (s.validationMessage) s.validationMessage.className = mergeClasses(s.validationMessage.className, styles.validation);
  },
  useSwitchStyles_unstable: (state) => {
    const s = state as { root: { className?: string }; indicator: Slot; input: Slot; label?: Slot; disabled?: boolean };
    const styles = useSwitch();
    s.root.className = mergeClasses(s.root.className, styles.root, s.disabled && styles.disabled);
    if (s.indicator) s.indicator.className = mergeClasses(s.indicator.className, styles.indicator);
    if (s.input) s.input.className = mergeClasses(s.input.className, styles.input);
    if (s.label) s.label.className = mergeClasses(s.label.className, styles.label);
  },
  useCheckboxStyles_unstable: (state) => {
    const s = state as { indicator?: Slot; input?: Slot; label?: Slot; shape?: string };
    const styles = useChoice();
    if (s.indicator) s.indicator.className = mergeClasses(s.indicator.className, s.shape === 'circular' ? styles.circle : styles.box);
    if (s.input) s.input.className = mergeClasses(s.input.className, styles.boxInput);
    if (s.label) s.label.className = mergeClasses(s.label.className, styles.label);
  },
  useRadioStyles_unstable: (state) => {
    const s = state as { indicator?: Slot; input?: Slot; label?: Slot };
    const styles = useChoice();
    if (s.indicator) s.indicator.className = mergeClasses(s.indicator.className, styles.circle);
    if (s.input) s.input.className = mergeClasses(s.input.className, styles.boxInput);
    if (s.label) s.label.className = mergeClasses(s.label.className, styles.label);
  },
  useLinkStyles_unstable: (state) => {
    const s = state as { root: { className?: string } };
    s.root.className = mergeClasses(s.root.className, useLink().root);
  },
};
