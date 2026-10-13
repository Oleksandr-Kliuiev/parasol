import { randomUUID } from 'node:crypto';
import { project } from '../../packages/ask/projection.ts';
import type { AskSourceRead } from '../../packages/ask/source.ts';
import type { AskIntent } from '../../packages/ask/contracts.ts';
import { capabilityV2 } from '../../packages/ask/remote/contracts.ts';
import type { AskAnswerV2 } from '../../packages/ask/remote/contracts.ts';
import { remoteAnswer } from '../../packages/ask/remote/answer.ts';
import { AT, askHeaders, dbRead } from './operator-ask.ts';
import type { Frame } from './operator-ask.ts';
import { journeyItems, WS } from './operator-journey.ts';

// ASK-REMOTE R-C browser test support: genuine AskCapabilityV2 / AskAnswerV2 bodies produced by the ACCEPTED R-B server
// modules (packages/ask/remote/{contracts,answer}.ts, imported read-only, never changed): the intent is chosen by the test
// (the scripted stand-in for the remote interpreter), every fact/claim is compiled by the shared selector and compiler. No
// provider, key or network exists here; values are synthetic.

export const ADMISSION = '5b0c9e57-3f7a-4d2e-9c1b-6a8e2f4d7c10';
/** A synthetic policy version beyond Number.MAX_SAFE_INTEGER: any Number coercion would change it. */
export const BIG_VERSION = '9007199254740993';

/** The exact remote capability body the R-B server emits for this tuple. */
export const remoteCapabilityBody = (admissionId = ADMISSION, policyVersion = BIG_VERSION) => capabilityV2(admissionId, policyVersion);
export const remoteCapabilityResponse = (admissionId = ADMISSION, policyVersion = BIG_VERSION, correlationId = randomUUID()): Response =>
  new Response(JSON.stringify(remoteCapabilityBody(admissionId, policyVersion)), { status: 200, headers: askHeaders(correlationId) });

/** The AskAnswerV2 the R-B server compiles for `intent` over `source` (DB only), exactly as serialized on the wire. */
export function remoteCompiled(source: AskSourceRead, intent: AskIntent, focusId: string | null, frame: Frame): AskAnswerV2 {
  const projection = project(source);
  const { json } = remoteAnswer(intent, { requestId: frame.requestId ?? randomUUID(), correlationId: frame.correlationId ?? randomUUID(),
    workspaceId: frame.workspaceId, clientId: frame.clientId, sourceMode: source.mode, focusObservationId: focusId, generatedAt: AT }, projection, focusId);
  return JSON.parse(json) as AskAnswerV2;
}

/** The DB journey read (accepted operator-journey page) for a recorded AskRequestV2 body, plus a confirmed device link. */
export function journeyRemoteAnswer(body: { requestId: string; observationId: string | null }, intent: AskIntent, clientId: string): AskAnswerV2 {
  const { source, focusId } = dbRead({ workspaceId: WS, clientId, page: journeyItems().map(o => ({ ...o, clientId })),
    focus: body.observationId === null ? null : { id: body.observationId }, devices: [{ id: 'd-1', label: 'HOST-01' }],
    links: [{ status: 'CONFIRMED', entityId: 'd-1', entityKind: 'DEVICE', system: 'atera', resourceType: 'agent', connectionId: 'conn-atera', externalId: 'agent-1' }] });
  return remoteCompiled(source, intent, focusId, { requestId: body.requestId, workspaceId: WS, clientId });
}

/** The exact acknowledgement a consented REMOTE request must carry for this tuple. */
export const acknowledgement = (admissionId = ADMISSION, policyVersion = BIG_VERSION) =>
  ({ contractVersion: 'AskRemoteDisclosureV1', admissionId, policyVersion, questionDataClass: 'SYNTHETIC' });
