import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, writeSync, constants } from 'node:fs';
import { dirname } from 'node:path';
import { decodeTerminalObservation } from './eval-wire.ts';
import type { TerminalObservation } from './eval-wire.ts';

/**
 * C's safe terminal-observation journal (06 "For each requested observation C validates S's fresh authenticated response and
 * atomically saves ONLY the closed safe record/provenance before forwarding it or sending OBSERVATION_COLLECTED"). Append-only
 * JSON lines in the owner's 0700 config directory (file 0600, O_NOFOLLOW): each line is one validated record plus fixed
 * provenance, written with ONE write and fsync'd before the caller proceeds. Cap 32 MiB (200 cases × 16 revisions × 8 KiB);
 * any failure is METADATA_PERSIST_FAILED for the caller (S keeps its record; arming stops). No raw or secret object can enter.
 */
export const JOURNAL_CAP = 32 * 1024 * 1024;
export class JournalError extends Error { constructor() { super('METADATA_PERSIST_FAILED'); this.name = 'JournalError'; } }
export class TerminalJournal {
  readonly #path: string;
  #failed = false;
  constructor(path: string) { this.#path = path; }
  get failed(): boolean { return this.#failed; }
  save(record: unknown, provenance: { serverBootId: string; receivedAt: string }): TerminalObservation {
    let fd: number | null = null; let before = -1;
    try {
      if (this.#failed) throw new JournalError();
      const obs = decodeTerminalObservation(record);
      const line = `${JSON.stringify({ contractVersion: 'RevalTerminalJournalV1', serverBootId: provenance.serverBootId, receivedAt: provenance.receivedAt, record: obs })}\n`;
      const created = !existsSync(this.#path);
      fd = openSync(this.#path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const st = fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid!() || st.size + Buffer.byteLength(line) > JOURNAL_CAP) throw new JournalError();
      before = st.size;
      // rc2 (review F9): a new file's directory entry is made durable too (on macOS Node's fsync is libuv's F_FULLFSYNC — measured, RS-D-C).
      if (created) { const dfd = openSync(dirname(this.#path), constants.O_RDONLY); try { fsyncSync(dfd); } finally { closeSync(dfd); } }
      const bytes = Buffer.from(line, 'utf8');
      if (writeSync(fd, bytes) !== bytes.length) throw new JournalError();
      fsyncSync(fd);
      return obs;
    } catch {
      // rc2 (F9): never leave a torn line behind — cut back to the size before this append (best effort), then fail sticky.
      if (fd !== null && before >= 0) { try { ftruncateSync(fd, before); fsyncSync(fd); } catch { /* the failure stays sticky */ } }
      this.#failed = true;
      throw new JournalError();
    } finally { if (fd !== null) closeSync(fd); }
  }
}
