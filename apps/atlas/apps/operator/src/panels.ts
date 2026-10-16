// Asynchronous isolation primitives shared by the controllers (docs/stage5/03_SECURITY_AND_STATE.md). DOM-free.
// Abort is only a courtesy to the network: the captured generations decide whether a completion may change anything.
import type { FailureCode } from './contracts.ts';
import type { CredentialHolder } from './credential.ts';
import type { ConsoleState } from './state.ts';
import type { TransportOptions } from './transport.ts';

/** One panel's request generation and abort controller. */
export class PanelWork {
  #generation = 0;
  #abort = new AbortController();
  /** Invalidates (and aborts) every earlier request of this panel. */
  reset(): void { this.#abort.abort(); this.#abort = new AbortController(); this.#generation += 1; }
  /** Starts the panel's newest request: its signal, and a check that stays true only while no later reset happened. */
  start(): { readonly signal: AbortSignal; current(): boolean } {
    this.reset();
    const generation = this.#generation;
    return { signal: this.#abort.signal, current: () => generation === this.#generation };
  }
}

export interface ControllerOptions extends TransportOptions {
  /** Fresh opaque request ID per deliberate evidence click (default crypto.randomUUID). */
  readonly requestId?: () => string;
  /** Fresh canonical lowercase UUIDv4 per Ask question (default crypto.randomUUID); anything else sends nothing. */
  readonly askRequestId?: () => string;
}

/** What the queue and evidence controllers share with the session/scope controller. */
export interface Kernel {
  readonly holder: CredentialHolder;
  readonly options: ControllerOptions;
  state(): ConsoleState;
  set(patch: Partial<ConsoleState>): void;
  /** Captures the credential and scope epochs: the check is true while neither has changed since the capture. */
  scope(): () => boolean;
  /**
   * Shared handling of a CURRENT failure: 401 disconnects globally; 403 clears the whole scope and refreshes the picker
   * exactly once, with no automatic selection. Returns true when the code was handled this way.
   */
  denied(code: FailureCode): boolean;
}
