import { makeStyles, tokens } from '@fluentui/react-components';

/**
 * A switch or checkbox in a field grid next to labelled fields sits on their control row: below the space of a label
 * (18 px line + 6 px gap) and centred on the 42 px control, whether or not the neighbours carry a hint under the
 * control. On a phone the grid is one column and the switch follows the field above it directly.
 */
export const controlRow = {
  display: 'flex',
  alignItems: 'center',
  alignSelf: 'start',
  minHeight: '42px',
  marginTop: '24px',
  '@media (max-width: 600px)': { marginTop: 0 },
} as const;

export const useDialogStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: '14px 16px', alignItems: 'start', '& .fui-Dropdown, & .fui-Combobox': { minWidth: 0 } },
  wide: { gridColumn: '1 / -1' },
  error: { marginBottom: tokens.spacingVerticalM },
  // A notice under the fields (a preview result, a server error after an action).
  after: { marginTop: '12px' },
  controlRow,
  // Switches that stand on a row of their own, after the fields.
  switches: { gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 24px' },
  // One short explanation above the fields of a dialog.
  lead: { marginTop: 0, marginBottom: '14px', maxWidth: '75ch', fontSize: '13.5px', lineHeight: '20px' },
});
