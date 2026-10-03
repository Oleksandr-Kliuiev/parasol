import { createDarkTheme, createLightTheme, type BrandVariants, type Theme } from '@fluentui/react-components';

// Fjord teal brand ramp; shade 80 (#0A6B73) is the primary colour in light mode.
const vardahei: BrandVariants = {
  10: '#010F11',
  20: '#03191C',
  30: '#052428',
  40: '#062F34',
  50: '#073A40',
  60: '#08464D',
  70: '#09535B',
  80: '#0A6B73',
  90: '#217A82',
  100: '#3A8990',
  110: '#53989E',
  120: '#6CA8AD',
  130: '#86B8BC',
  140: '#A1C8CB',
  150: '#BCD9DB',
  160: '#D8EAEB',
};

export const lightTheme: Theme = createLightTheme(vardahei);

export const darkTheme: Theme = {
  ...createDarkTheme(vardahei),
  colorBrandForeground1: vardahei[110],
  colorBrandForeground2: vardahei[120],
  colorBrandForegroundLink: vardahei[120],
};
