import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

// Dialogs carry the motion of the visual system through the shared wrapper.
const dialogImport = { name: '@fluentui/react-components', importNames: ['Dialog'], message: 'Import Dialog from src/shared/components/Dialog.' };
// The browser's own boxes ignore the theme, the motion and the app's validation messages.
const nativeDialogs = ['alert', 'confirm', 'prompt'];
const nativeDialog = 'Ask in a Dialog from src/shared/components/Dialog, not in the browser box.';

export default tseslint.config(
  { ignores: ['dist', 'coverage'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-imports': ['error', { paths: [dialogImport] }],
      'no-restricted-globals': ['error', ...nativeDialogs.map((name) => ({ name, message: nativeDialog }))],
      'no-restricted-properties': ['error', ...['window', 'globalThis'].flatMap((object) => nativeDialogs.map((property) => ({ object, property, message: nativeDialog })))],
    },
  },
  {
    // Modules of the first download (scripts/bundle-budget.mjs) take their icons one family at a time.
    files: [
      'src/app/{AppShell,Sidebar,TopBar,BottomTabs,navigation}.tsx',
      'src/auth/**/*.tsx',
      'src/features/errors/**/*.tsx',
      'src/features/operations/{MaintenanceBanner,SignInPausedPage}.tsx',
      'src/features/notifications/NotificationsBell.tsx',
    ],
    ignores: ['**/*.test.tsx'],
    rules: {
      'no-restricted-imports': ['error', { paths: [dialogImport, {
        name: '@fluentui/react-icons',
        message: 'Shell modules import icons from src/app/shellIcons: the package index brings the icons of every page into the first download.',
      }] }],
    },
  },
);
