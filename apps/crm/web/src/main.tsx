import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from './i18n';
import './styles.css';
import { App } from './app/App';
import { watchScrollLock } from './app/scrollLock';
import { restoreMissingFocusin } from './app/focusin';

// While a modal locks the page scroll, its backdrop reaches the window edge and nothing behind it moves (app/scrollLock.ts).
watchScrollLock();
// Safari gives date and time fields focus without the focusin that Fluent's modals and React's onFocus wait for, so a
// dialog that opens on one would stay hidden from screen readers (app/focusin.ts). Before the first render, so before any focus.
restoreMissingFocusin();

// The texts of the chosen language load before the first render, so no screen flashes untranslated keys.
await initI18n();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
