// Composition of the local operator console (S5-A/S5-B). Wires the static skeleton to the controller; holds no data itself.
// The password field is read once per submit and cleared immediately, before any request; its value never enters state.
import { createCredentialHolder } from './credential.ts';
import { createController } from './controller.ts';
import { createView } from './view.ts';
import { byId } from './dom.ts';
import { isConsoleLocation } from './origin.ts';
import { disconnectedState } from './state.ts';
import type { ConsoleState } from './state.ts';

const nativeFetch = globalThis.fetch.bind(globalThis);
const holder = createCredentialHolder((input, init) => nativeFetch(input, init));
let view: ReturnType<typeof createView> | null = null;
const controller = createController(holder, (state: ConsoleState) => view?.render(state));
view = createView(controller);

const form = byId('connect-form', HTMLFormElement);
const token = byId('token', HTMLInputElement);
const submit = byId('connect-submit', HTMLButtonElement);
const search = byId('client-search', HTMLInputElement);

if (!isConsoleLocation(location.origin, location.pathname)) {
  // Outside the exact loopback console origin the token form is disabled; no credential can be entered or sent.
  token.disabled = true; submit.disabled = true;
  view.render(disconnectedState('ORIGIN_REFUSED'));
} else {
  view.render(controller.state());
  form.addEventListener('submit', event => {
    event.preventDefault();
    const raw = token.value;
    token.value = '';
    controller.connect(raw);
  });
  byId('disconnect', HTMLButtonElement).addEventListener('click', () => controller.disconnect('DISCONNECTED'));
  byId('refresh-clients', HTMLButtonElement).addEventListener('click', () => controller.refreshClients());
  byId('refresh-queue', HTMLButtonElement).addEventListener('click', () => controller.refreshQueue());
  search.addEventListener('input', () => controller.search(search.value));
  // Leaving or hiding the page destroys the credential and all data; a page restored from the back/forward cache comes
  // back disconnected instead of showing authenticated content.
  addEventListener('pagehide', () => { token.value = ''; controller.disconnect('PAGE_HIDDEN'); });
  addEventListener('pageshow', event => { if (event.persisted) { token.value = ''; controller.disconnect('PAGE_HIDDEN'); } });
}
