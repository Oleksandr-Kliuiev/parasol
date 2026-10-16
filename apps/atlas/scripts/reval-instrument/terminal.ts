// The instrument's checks of a collected terminal observation (06 "Original-task terminal observation"; rs-c brief B §8 rc2 F2/F4).
// C already verified the record's schema, its armId and the registration/boot. I additionally requires the record's whole Binding to
// answer I's OWN READY on its own handoff connection (and the correlation that S handed off, when one arrived); a FINAL record must
// agree with the COMMITTED handed-off status/code. Failure precedence (06): any authenticated non-NONE detectedFault blocks credit
// and further arming whatever the handoff state; a case without a FINAL record is never credited (missing coverage blocks credit).
import type { TerminalObservation } from '../../packages/reval/eval-wire.ts';
import { bindingMatchesReady } from './transfer.ts';
import type { ReadySent } from './transfer.ts';

/** RS-D-A adds CENSUS_UNVERIFIED: the case's POST process census did not match its PRE census and terminal record (census.ts). */
export type CreditBlock = 'TERMINAL_NOT_FINAL' | 'TERMINAL_FAULT' | 'TERMINAL_MISMATCH' | 'CENSUS_UNVERIFIED';
export const CREDIT_BLOCKS: readonly CreditBlock[] = ['TERMINAL_NOT_FINAL', 'TERMINAL_FAULT', 'TERMINAL_MISMATCH', 'CENSUS_UNVERIFIED'];
/** The safe facts of what S handed off (no raw value): correlation, status and the public error code (null for an answer). */
export interface Handed { readonly correlationId: string; readonly status: number; readonly code: string | null }

/** The record answers I's own arm: every READY field, the handoff connection and (when known) the handed-off correlation. */
export function terminalMatches(o: TerminalObservation, ready: ReadySent, handoffConnectionId: string, handed: Handed | null): boolean {
  return bindingMatchesReady(o.binding, ready, handoffConnectionId) && (handed === null || o.binding.correlationId === handed.correlationId);
}
/** A FINAL publication equals the COMMITTED handoff: SERVER_FINISHED with the same status, ANSWER for 200 or the same public code. */
export function publicationMatches(o: TerminalObservation, handed: Handed): boolean {
  const p = o.publication;
  if (p.state !== 'SERVER_FINISHED' || p.status !== handed.status) return false;
  return p.kind === 'ANSWER' ? handed.code === null : p.code === handed.code;
}
/** Why I withholds credit for a case (null = not blocked here; the RC5 session still decides pass/fail). */
export function creditBlockOf(o: TerminalObservation | null, committed: Handed | null): CreditBlock | null {
  if (o === null || !o.final) return 'TERMINAL_NOT_FINAL';
  if (o.detectedFault !== 'NONE') return 'TERMINAL_FAULT';
  if (committed !== null && !publicationMatches(o, committed)) return 'TERMINAL_MISMATCH';
  return null;
}
