// Composition of the MEASURED console build (rs-c brief C §3). The accepted session/context/queue/evidence controllers and views
// run unchanged on the measured holder; the accepted Ask form is never offered here (the view receives the Ask capability masked
// to OFF), while the evaluation panel reads the real validated REMOTE capability read-only. Served only by the measured bridge
// server at /operator/ (apps/api/src/reval/evaluation.ts); the ordinary console build never contains this file.
import { createController } from '../src/controller.ts';
import { createView } from '../src/view.ts';
import { byId } from '../src/dom.ts';
import { isConsoleLocation } from '../src/origin.ts';
import { disconnectedState } from '../src/state.ts';
import type { ConsoleState } from '../src/state.ts';
import type { AskCapabilityState } from '../src/ask-state.ts';
import { createMeasuredHolder } from './credential-measured.ts';
import { createEvalController } from './eval-controller.ts';
import { createEvalView } from './view-eval.ts';

const ASK_MASKED: AskCapabilityState = Object.freeze({ status: 'OFF', failure: null, disclosure: null });
const masked = (state: ConsoleState): ConsoleState => ({ ...state, askCapability: ASK_MASKED });

const nativeFetch = globalThis.fetch.bind(globalThis);
const holder = createMeasuredHolder((input, init) => nativeFetch(input, init));
let view: ReturnType<typeof createView> | null = null;
let evalView: ReturnType<typeof createEvalView> | null = null;
let evaluation: ReturnType<typeof createEvalController> | null = null;
const controller = createController(holder, (state: ConsoleState) => {
  view?.render(masked(state));
  evaluation?.observe(state);
  if (evaluation) evalView?.render(evaluation.state(), state);
});
evaluation = createEvalController(holder, ui => evalView?.render(ui, controller.state()), { onUnauthorized: () => controller.disconnect('UNAUTHORIZED'),
  onForbidden: () => controller.refreshClients() });
view = createView(controller);
evalView = createEvalView(evaluation);
evaluation.observe(controller.state());

const form = byId('connect-form', HTMLFormElement);
const token = byId('token', HTMLInputElement);
const submit = byId('connect-submit', HTMLButtonElement);
const search = byId('client-search', HTMLInputElement);
const nonce = byId('eval-nonce', HTMLInputElement);

if (!isConsoleLocation(location.origin, location.pathname)) {
  // Outside the exact loopback console origin nothing can be entered or sent.
  token.disabled = true; submit.disabled = true; nonce.disabled = true;
  view.render(masked(disconnectedState('ORIGIN_REFUSED')));
} else {
  view.render(masked(controller.state()));
  evalView.render(evaluation.state(), controller.state());
  form.addEventListener('submit', event => {
    event.preventDefault();
    const raw = token.value;
    token.value = '';
    controller.connect(raw);
  });
  byId('disconnect', HTMLButtonElement).addEventListener('click', () => { evaluation?.pageHidden(); controller.disconnect('DISCONNECTED'); });
  byId('refresh-clients', HTMLButtonElement).addEventListener('click', () => controller.refreshClients());
  byId('refresh-queue', HTMLButtonElement).addEventListener('click', () => controller.refreshQueue());
  search.addEventListener('input', () => controller.search(search.value));
  // Leaving or hiding the page destroys the credential, the pair and all data; a back/forward-cache restore comes back disconnected.
  const hide = () => { token.value = ''; nonce.value = ''; evaluation?.pageHidden(); controller.disconnect('PAGE_HIDDEN'); };
  addEventListener('pagehide', hide);
  addEventListener('pageshow', event => { if (event.persisted) hide(); });
}
