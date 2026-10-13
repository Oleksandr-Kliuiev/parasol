/**
 * Atlas-normalized PowerOffice export port (docs/stage4/04_PORT_AND_SYNC.md "Built in port"). NOT a vendor wire contract
 * and not a transport: no method, URL, header, credential, token, origin, file or callback exists here. The only
 * implementation is the built-in deterministic synthetic export (builtin.ts) composed by packages/poweroffice/composition.ts.
 *
 * A session is an opaque frozen object whose pins live in the port's private WeakMap: the trusted composition opens it
 * after a committed claim, pinned to the connection, the bound synthetic company key, the lifecycle version, the attempt
 * and the claim's DB asOf. A serialized or fabricated copy is unknown to the port. readPage is called at most once per
 * ordinal, serially from 1 (no retry, no skip); it returns exactly one normalized page (packages/poweroffice/dto.ts shape)
 * or rejects with the fixed POWEROFFICE_SOURCE_FAILED. The caller validates everything it returns before contribution.
 *
 * Control: the AbortSignal of this invocation and the performance.now() instant at which it is cancelled. A port checks
 * both before and after its work and honors an abort or the deadline while in flight (the promise rejects; a later
 * result never resolves it). closeSession ends the session for good; nothing of a closed session is retained.
 */
export interface SessionPins {
  readonly connectionId: string; readonly companyKey: string; readonly lifecycleVersion: number; readonly attemptId: string; readonly asOf: string;
}
export interface ExportSession { readonly kind: 'PowerOfficeExportSession' }
export interface PageControl { readonly signal: AbortSignal; readonly monotonicDeadline: number }
export interface PowerOfficeExportPort {
  openSession(pins: SessionPins): ExportSession;
  readPage(session: ExportSession, expectedOrdinal: number, control: PageControl): Promise<unknown>;
  closeSession(session: ExportSession): void;
}

/** Cancelled when the signal fired or the invocation's monotonic deadline has been reached. */
export const pageCancelled = (control: PageControl): boolean => control.signal.aborted || performance.now() >= control.monotonicDeadline;
