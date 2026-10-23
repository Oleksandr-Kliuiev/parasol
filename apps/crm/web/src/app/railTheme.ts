import { createDarkTheme, type Theme } from '@fluentui/react-components';
import { darkTheme, ember } from './theme';

// The navigation rail is dark in both colour schemes (UX concept §8, --rail-* tokens). It is a nested FluentProvider
// theme, so the drawer's own components (items, section headers, focus ring) read dark tokens without touching the page.
function rail(background: string): Theme {
  return {
    ...createDarkTheme(ember),
    ...darkTheme,
    // Fluent paints the drawer with Background4 and the provider element with Background1: the rail needs both to match.
    colorNeutralBackground1: background,
    colorNeutralBackground2: background,
    colorNeutralBackground3: background,
    colorNeutralBackground4: background,
    colorNeutralBackground1Hover: 'rgba(255, 255, 255, 0.05)',
    colorNeutralBackground1Pressed: 'rgba(255, 255, 255, 0.09)',
    colorNeutralBackground1Selected: '#2E2824',
    colorSubtleBackgroundHover: 'rgba(255, 255, 255, 0.05)',
    colorSubtleBackgroundPressed: 'rgba(255, 255, 255, 0.09)',
    colorSubtleBackgroundSelected: '#2E2824',
    colorNeutralForeground1: '#EFE9E1',
    colorNeutralForeground1Hover: '#EFE9E1',
    colorNeutralForeground1Pressed: '#EFE9E1',
    colorNeutralForeground1Selected: '#EFE9E1',
    colorNeutralForeground2: '#EFE9E1',
    colorNeutralForeground2Hover: '#EFE9E1',
    colorNeutralForeground2Pressed: '#EFE9E1',
    colorNeutralForeground2Selected: '#EFE9E1',
    // The selected entry marks itself with the ember accent on its icon; text stays neutral for contrast.
    colorNeutralForeground2BrandHover: '#EFE9E1',
    colorNeutralForeground2BrandPressed: '#EFE9E1',
    colorNeutralForeground2BrandSelected: '#EE7550',
    colorNeutralForeground3: '#A1978D',
    colorNeutralForeground3Hover: '#EFE9E1',
    colorNeutralForeground3Pressed: '#EFE9E1',
    colorNeutralForeground3Selected: '#EFE9E1',
    colorNeutralStroke1: 'rgba(255, 255, 255, 0.16)',
    colorNeutralStroke2: 'rgba(255, 255, 255, 0.08)',
    colorNeutralStrokeSubtle: 'rgba(255, 255, 255, 0.08)',
  };
}

export const railThemeLightPage: Theme = rail('#1B1714');
export const railThemeDarkPage: Theme = rail('#0F0D0C');
