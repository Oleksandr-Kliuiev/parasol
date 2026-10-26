import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from './i18n';
import './styles.css';
import { App } from './app/App';
import { watchScrollLock } from './app/scrollLock';

// While a modal locks the page scroll, its backdrop reaches the window edge and nothing behind it moves (app/scrollLock.ts).
watchScrollLock();

// The texts of the chosen language load before the first render, so no screen flashes untranslated keys.
await initI18n();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
