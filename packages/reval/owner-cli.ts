import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { Channel } from './channel.ts';
import { exitCodeDisplay, RESPONSE_KIND } from './codes.ts';
import type { Operation } from './codes.ts';
import { REQUESTER_DEADLINE_MS } from './closure.ts';
import { loadOwnerConfig } from './config.ts';
import { buildRequest, checkResponse, decodeFailurePayload, decodeResponse, Sequence } from './envelope.ts';
import type { ConnectionBinding } from './envelope.ts';
import { METADATA_FRAME_CAP } from './frame.ts';
import { awaitExit, spawnController } from './launch.ts';
import { decodeClosure, decodeFixtureCheck, decodeIdentity, decodeSnapshot } from './payloads.ts';
import { isAbsPath, isDec64, isPositiveDec64, isUuid } from './scalars.ts';
import { decodePairAck, decodePairSecret, decodeTerminalObservation } from './eval-wire.ts';
import { decodeDrain, decodeProcessCensus } from './census-payloads.ts';
import { decodePlatformProof, decodePrivacyProof } from './proof-payloads.ts';

/**
 * The owner CLI O (brief §2a/§9): the ONLY process with a TTY (refused without one); a closed-grammar REPL with readline
 * history off; one option `--config <abs path>`. O generates the O↔C connectionId and serverBootId, spawns C detached with
 * the three launch identifiers only, and prints ONLY validated safe payload JSON (`OK <KIND> <json>`), a fixed
 * `FAILURE <code>`, or a LOCALLY mapped C exit code (`LOCAL <code>`, never presented as a C-authenticated response).
 */
type Command = { op: Operation; payload: Record<string, unknown> } | { op: 'QUIT' } | null;
export function parseCommand(line: string): Command {
  const t = line.trim().split(/ +/);
  const [name, ...args] = t;
  const none = (op: Operation): Command => args.length === 0 ? { op, payload: {} } : null;
  switch (name) {
    case 'identity': return none('IDENTITY');
    case 'snapshot': return none('SNAPSHOT');
    case 'process-census': return none('PROCESS_CENSUS');
    case 'drain': return none('DRAIN');
    case 'platform-proof': return none('PLATFORM_PROOF');
    case 'privacy-proof': return none('PRIVACY_PROOF');
    case 'fixture-check': return none('FIXTURE_CHECK');
    case 'terminal-observation': return args.length === 1 && isUuid(args[0]) ? { op: 'TERMINAL_OBSERVATION', payload: { armId: args[0] } } : null;
    case 'pair': return args.length === 2 && isUuid(args[0]) && isUuid(args[1])
      ? { op: 'PAIR', payload: { instrumentControlConnectionId: args[0], instrumentHandoffConnectionId: args[1] } } : null;
    case 'end-pair': return args.length === 1 && isUuid(args[0]) ? { op: 'END_PAIR', payload: { pairId: args[0] } } : null;
    case 'pause-export': return args.length === 4 && isUuid(args[0]) && isPositiveDec64(args[1]) && isDec64(args[2]) && isDec64(args[3])
      ? { op: 'PAUSE_EXPORT', payload: { admissionId: args[0], expectedPolicyVersion: args[1], policyFloor: args[2], fenceFloor: args[3] } } : null;
    case 'quit': return args.length === 0 ? { op: 'QUIT' } : null;
    default: return null;
  }
}
/** 06: the original producer of a non-FAILURE answer to O — S for its forwarded terminal record and (RS-D-A) its guard census. */
export function ownerEmitter(op: Operation): 'CONTROLLER' | 'SERVER' { return op === 'TERMINAL_OBSERVATION' || op === 'PROCESS_CENSUS' ? 'SERVER' : 'CONTROLLER'; }
/** Validated safe payload of a response to `op` (throws on any deviation). */
function safePayload(op: Operation, kind: string, payload: unknown): unknown {
  if (kind === 'FAILURE') return decodeFailurePayload(payload);
  if (kind !== RESPONSE_KIND[op]) throw new Error('kind');
  if (kind === 'IDENTITY') return decodeIdentity(payload);
  if (kind === 'SNAPSHOT') return decodeSnapshot(payload);
  if (kind === 'FIXTURE_CHECK') return decodeFixtureCheck(payload);
  if (kind === 'PAIR_ACK') return decodePairAck(payload);
  if (kind === 'TERMINAL_OBSERVATION') return decodeTerminalObservation(payload);
  if (kind === 'PROCESS_CENSUS') return decodeProcessCensus(payload);
  if (kind === 'DRAIN') return decodeDrain(payload);
  if (kind === 'PLATFORM_PROOF') return decodePlatformProof(payload);
  if (kind === 'PRIVACY_PROOF') return decodePrivacyProof(payload);
  return decodeClosure(payload);
}

export interface OwnerOptions { readonly argv: readonly string[]; readonly controllerEntry: string }
export async function runOwner(o: OwnerOptions): Promise<never> {
  const out = (s: string) => process.stdout.write(`${s}\n`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) { out('REFUSED NO_TTY'); process.exit(2); }
  if (o.argv.length !== 2 || o.argv[0] !== '--config' || !isAbsPath(o.argv[1])) { out('REFUSED USAGE'); process.exit(2); }
  let config;
  try { config = await loadOwnerConfig(o.argv[1]!); } catch { out('REFUSED CONFIG'); process.exit(2); }
  const binding: ConnectionBinding = { registrationId: config.registrationId, serverBootId: randomUUID(), connectionId: randomUUID() };
  const child = spawnController(o.controllerEntry, { config: o.argv[1]!, connectionId: binding.connectionId, serverBootId: binding.serverBootId });
  const channel = new Channel(child.stdio[3] as Socket, METADATA_FRAME_CAP);
  const send = new Sequence(); const recv = new Sequence();
  let finished = false;
  const finish = async (): Promise<never> => {
    if (!finished) { finished = true; channel.close(); }
    if (!await awaitExit(child, 7000)) { child.kill('SIGKILL'); await awaitExit(child, 1000); }
    process.exit(0);
  };
  child.once('exit', code => {
    if (finished) return;
    finished = true; out(`LOCAL ${exitCodeDisplay(code)}`); process.exit(code === 0 ? 0 : 3);
  });
  process.on('SIGINT', () => { void finish(); }); process.on('SIGHUP', () => { void finish(); });
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0, prompt: 'reval> ' });
  rl.prompt();
  for await (const line of rl) {
    const cmd = parseCommand(line);
    if (cmd === null) { out('REFUSED GRAMMAR'); rl.prompt(); continue; }
    if (cmd.op === 'QUIT') return finish();
    const outstanding = { challenge: randomUUID(), sequence: send.take(), operation: cmd.op };
    try { channel.send(buildRequest(binding, outstanding.challenge, outstanding.sequence, cmd.op, cmd.payload)); } catch { return finish(); }
    let value: unknown;
    try { value = await channel.next(REQUESTER_DEADLINE_MS); }
    catch (error) {
      if ((error as { reason?: string }).reason === 'TIMEOUT') { out('FAILURE DEADLINE'); return finish(); }
      await awaitExit(child, 3000); return finish();
    }
    try {
      const r = decodeResponse(value);
      // RS-C-A: a terminal observation is the SERVER's original record forwarded by C (06: forwarding preserves its origin).
      const problem = checkResponse(binding, recv, outstanding, r, ownerEmitter(cmd.op), config.databaseInstanceId);
      if (problem) throw new Error(problem);
      const payload = safePayload(cmd.op, r.kind, r.payload);
      out(r.kind === 'FAILURE' ? `FAILURE ${(payload as { code: string }).code}` : `OK ${r.kind} ${JSON.stringify(payload)}`);
      if (cmd.op === 'PAIR' && r.kind === 'PAIR_ACK') {
        // The private secret frame follows on C's NEXT send sequence within the same operation (06): exact, echoing the PAIR
        // request; the nonce is shown only here, in the owner's terminal, never in a safe payload or a file.
        const s = decodePairSecret(await channel.next(REQUESTER_DEADLINE_MS));
        if (!recv.expect(s.sequence) || s.challenge !== outstanding.challenge || s.requestSequence !== outstanding.sequence
          || s.registrationId !== binding.registrationId || s.serverBootId !== binding.serverBootId || s.connectionId !== binding.connectionId
          || s.pairId !== (payload as { pairId: string }).pairId) throw new Error('secret');
        out(`SECRET PAIRING_NONCE ${s.pairingNonce} ${s.expiresAt}`);
      }
    } catch { out('FAILURE PROTOCOL_INVALID'); return finish(); }
    rl.prompt();
  }
  return finish();
}
