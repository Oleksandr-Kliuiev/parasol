import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from './i18n';
import './styles.css';
import { App } from './app/App';

// The texts of the chosen language load before the first render, so no screen flashes untranslated keys.
await initI18n();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
