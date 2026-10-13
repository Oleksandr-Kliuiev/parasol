// One validated Ask answer: status, recognized intent, claims through fixed dictionaries with request-local citations, the
// independent urgency notice, bounded coverage and every returned evidence card — for ALL statuses. Citation buttons only
// open and focus a card of this answer; there is no fetch, link, navigation or source URL. Values are text nodes. A REMOTE
// answer renders through the same code; only its origin line and unsupported wording differ (fixed text, no provider output).
import { el, untrusted } from './dom.ts';
import {
  ASK_ABSENCE, ASK_ANSWER_ORIGIN, ASK_CITATION_HINT, ASK_ENTITY_TEXT, ASK_FOCUS_NOT_RETURNED, ASK_INSUFFICIENT_NEUTRAL, ASK_INSUFFICIENT_NOTE, ASK_INTENT_LABEL,
  insufficientNotes, ASK_NOT_URGENT, ASK_NO_URGENT, ASK_REMOTE_UNSUPPORTED_LABEL, ASK_REMOTE_UNSUPPORTED_TEXT, ASK_SEPARATE_READ, ASK_STATUS_HEADING,
  ASK_UNSUPPORTED_TEXT, ASK_URGENT_HEADING, ASK_URGENT_OMITTED, ASK_URGENT_REASON
} from './ask-messages.ts';
import type { AskAnswerView, AskClaim, AskEntityData, AskFact, AskObservationData, AskResourceData } from './ask-contracts.ts';
import { CONFIDENCE_NOTE, READ_STATUS_TEXT, urgentText } from './messages.ts';
import { code, fields, readStatus, severityNodes, timeText } from './view-parts.ts';

type Cite = (ref: string) => HTMLButtonElement;
const KIND_LABEL: Record<AskFact['kind'], string> = { OBSERVATION: 'Observation', RESOURCE_STATE: 'Stored read state', ENTITY: 'Entity reference' };

const resourceLabel = (r: AskResourceData): (Node | string)[] => [`${r.source} ${r.resourceType} on connection `, code(r.connectionId)];
const entityLabel = (e: AskEntityData): string => e.entityKind === 'PERSON' ? 'person' : e.entityKind === 'DEVICE' ? 'device' : 'entity';

function observationCard(o: AskObservationData): Node[] {
  return [fields([
    ['Observation ID', code(o.observationId)], ['Source', `${o.source} ${o.resourceType}`], ['Connection', code(o.connectionId)],
    ['Source event ID', code(o.externalEventId)], ['Source severity', severityNodes(o.severity)], ['Priority label', o.priority], ['Route', o.route],
    ['Confidence', `${Math.round(o.confidence * 100)}% (${CONFIDENCE_NOTE})`],
    ['Reason codes', o.reasonCodes.length ? el('ul', 'codes', ...o.reasonCodes.map(c => el('li', null, code(c)))) : 'none'],
    ['Lifecycle status', o.status], ['Entity ID', o.entityId === null ? 'none' : code(o.entityId)],
    ['Conflict', o.conflictOfEventKey === null ? 'none' : ['Conflicting revision of stored event ', code(o.conflictOfEventKey), ' (text reference only)']],
    ['Superseded', o.supersededById === null ? 'not superseded' : ['Superseded by observation ', code(o.supersededById), ' (text reference only)']],
    ['Occurred', timeText(o.occurredAt)], ['Created', o.createdAt], ['Updated', o.updatedAt],
    ['Acknowledged', o.acknowledgedAt ?? 'not acknowledged'], ['Resolved', o.resolvedAt ?? 'not resolved']
  ], 'fields fields-compact')];
}
function entityCard(e: AskEntityData): Node[] {
  const rows: [string, Node | string | (Node | string)[]][] = [['State', `${e.state} — ${ASK_ENTITY_TEXT[e.state]}`], ['For observation', code(e.observationId)],
    ['Entity ID', e.entityId === null ? 'none stored' : code(e.entityId)]];
  if (e.entityKind !== null) rows.push(['Kind', e.entityKind]);
  if (e.displayName !== null) rows.push(['Stored label', untrusted(e.displayName)]);
  if (e.confirmation !== null) {
    const c = e.confirmation;
    rows.push(['Confirmed link', [`${c.source} ${c.resourceType} on connection `, code(c.connectionId), ', source ID ', code(c.externalId)]]);
  }
  return [fields(rows, 'fields fields-compact')];
}
function cardTitle(fact: AskFact): (Node | string)[] {
  if (fact.kind === 'OBSERVATION') return [...severityNodes(fact.data.severity), ' ', ...untrusted(fact.data.summary)];
  if (fact.kind === 'RESOURCE_STATE') return [...resourceLabel(fact.data), ` — ${fact.data.status}`];
  return [`${fact.data.state} ${entityLabel(fact.data)}`, ...(fact.data.displayName === null ? [] : [': ', ...untrusted(fact.data.displayName)])];
}

/** Evidence cards (collapsed) and the opener the citation buttons use. */
function cards(answer: AskAnswerView): { list: HTMLElement; open(ref: string): void } {
  const byRef = new Map<string, HTMLDetailsElement>();
  const list = el('div', 'ask-facts');
  for (const fact of answer.evidence) {
    const summary = el('summary', 'ask-fact-summary', el('span', 'tag', fact.ref), ' ', el('span', 'muted small', KIND_LABEL[fact.kind]), ' ', ...cardTitle(fact));
    const body = fact.kind === 'OBSERVATION' ? observationCard(fact.data) : fact.kind === 'RESOURCE_STATE' ? readStatus(fact.data) : entityCard(fact.data);
    const card = el('details', 'ask-fact item', summary, ...body);
    byRef.set(fact.ref, card);
    list.append(card);
  }
  return { list, open(ref: string): void {
    const card = byRef.get(ref);
    if (!card) return;
    card.open = true;
    card.querySelector('summary')?.focus();
  } };
}

function claimText(claim: AskClaim, fact: AskFact): (Node | string)[] {
  if (fact.kind === 'OBSERVATION') {
    const o = fact.data;
    if (claim.code === 'SOURCE_URGENT') return [el('strong', null, urgentText(o.severity)), ' — ', ASK_URGENT_REASON, ' Observation: ', ...untrusted(o.summary)];
    if (claim.code === 'SOURCE_NOT_URGENT_IN_READ') return [`Source severity ${o.severity}: `, ASK_NOT_URGENT, ' Observation: ', ...untrusted(o.summary)];
    return ['Recorded observation: ', ...untrusted(o.summary), ' — source severity ', ...severityNodes(o.severity)];
  }
  if (fact.kind === 'RESOURCE_STATE') {
    const r = fact.data;
    return ['Stored read of ', ...resourceLabel(r), ': ', el('strong', null, r.status), ` — ${READ_STATUS_TEXT[r.status]}. As of ${timeText(r.asOf)}; last successful read ${timeText(r.lastSuccessAt)}.`,
      ...(r.truncated ? [' The read was bounded (truncated).'] : [])];
  }
  const e = fact.data;
  if (e.state === 'CONFIRMED' && e.confirmation && e.entityId !== null) {
    return [`Confirmed ${entityLabel(e)}: `, ...untrusted(e.displayName ?? ''), ' — exact graph ID ', code(e.entityId), ` with a confirmed ${e.confirmation.source} ${e.confirmation.resourceType} link, source ID `,
      code(e.confirmation.externalId), '.'];
  }
  return [ASK_ENTITY_TEXT[e.state], ...(e.entityId === null ? [] : [' Stored reference ', code(e.entityId), '.'])];
}

/** The whole answer region; its citation buttons open only the cards of this answer. */
export function answerNodes(answer: AskAnswerView): Node[] {
  const facts = new Map(answer.evidence.map(f => [f.ref, f] as const));
  const evidence = cards(answer);
  const cite: Cite = ref => {
    const node = el('button', 'btn btn-small btn-cite', el('span', 'visually-hidden', 'Show evidence '), ref);
    node.type = 'button';
    node.addEventListener('click', () => evidence.open(ref));
    return node;
  };
  const heading = el('h3', 'ask-answer-heading', ASK_STATUS_HEADING[answer.status]);
  heading.tabIndex = -1;
  const remote = answer.mode === 'remote';
  const intentLabel = remote && answer.intent === 'UNSUPPORTED' ? ASK_REMOTE_UNSUPPORTED_LABEL : ASK_INTENT_LABEL[answer.intent];
  const out: Node[] = [heading, el('p', 'muted small', intentLabel, ASK_ANSWER_ORIGIN[answer.mode])];
  const focusFound = answer.focusObservationId !== null && answer.evidence.some(f => f.kind === 'OBSERVATION' && f.data.observationId === answer.focusObservationId);
  out.push(el('p', 'small', ...(answer.focusObservationId === null ? ['Asked without a selected observation.']
    : ['Asked about observation ', code(answer.focusObservationId), focusFound ? '.' : `. ${ASK_FOCUS_NOT_RETURNED}`])));

  if (answer.status === 'UNSUPPORTED') out.push(el('p', 'notice notice-info', remote ? ASK_REMOTE_UNSUPPORTED_TEXT : ASK_UNSUPPORTED_TEXT));
  else if (answer.status === 'INSUFFICIENT') {
    const notes = insufficientNotes(answer);
    out.push(el('div', 'notice notice-warning ask-insufficient', el('p', null, ASK_INSUFFICIENT_NEUTRAL),
      ...(notes.length ? [el('ul', 'plain-list', ...notes.map(note => el('li', null, ASK_INSUFFICIENT_NOTE[note])))] : [])));
  }
  else {
    out.push(el('ol', 'ask-claims', ...answer.claims.map(claim => {
      const fact = facts.get(claim.ref)!;
      return el('li', null, ...claimText(claim, fact), ' ', cite(claim.ref));
    })), el('p', 'muted small', ASK_CITATION_HINT));
  }

  // Independent mandatory urgency notice: every HIGH/CRITICAL observation of the evidence, whatever the status or plan.
  const urgent = answer.urgentRefs.map(ref => facts.get(ref)!).filter((f): f is Extract<AskFact, { kind: 'OBSERVATION' }> => f.kind === 'OBSERVATION');
  if (urgent.length) {
    out.push(el('section', 'notice notice-urgent ask-urgent', el('p', 'strong', `${ASK_URGENT_HEADING}: ${urgent.length}`),
      el('ul', 'plain-list', ...urgent.map(f => el('li', null, el('strong', null, urgentText(f.data.severity)), ': ', ...untrusted(f.data.summary), ' ', cite(f.ref))))));
  } else out.push(el('p', 'notice notice-info', ASK_NO_URGENT));
  if (answer.coverage.urgentFactsOmitted) out.push(el('p', 'notice notice-warning', ASK_URGENT_OMITTED));

  const c = answer.coverage;
  const observations = answer.evidence.filter(f => f.kind === 'OBSERVATION').length;
  const resources = answer.evidence.filter(f => f.kind === 'RESOURCE_STATE').length;
  out.push(el('h4', null, 'What this answer read'), el('ul', 'plain-list small ask-coverage',
    el('li', null, `Active observations read: ${c.observationsRead} (limit ${c.observationLimit})${c.observationPageTruncated ? '; more active observations exist beyond this read' : ''}.`),
    ...(c.focusExtra ? [el('li', null, 'The selected observation was read in addition to that page.')] : []),
    el('li', null, `Evidence facts: ${answer.evidence.length} (limit ${c.bankLimit}), of which ${observations} observations and ${resources} stored-read states${c.observationFactsOmitted ? '; some observations read are not in the evidence' : ''}.`),
    el('li', null, `Stored source reads: ${c.resourcesRead}${c.resourceFactsOmitted ? '; some are not in the evidence (evidence limit or no explicit connection)' : ''}.`),
    ...(c.fixture ? [el('li', null, READ_STATUS_TEXT.FIXTURE, '.')] : []),
    el('li', null, ASK_ABSENCE), el('li', null, ASK_SEPARATE_READ)));
  out.push(el('h4', null, `Evidence returned with this answer (${answer.evidence.length})`));
  out.push(answer.evidence.length ? evidence.list : el('p', 'muted', 'No evidence facts in this bounded read.'));
  out.push(fields([['Answer compiled at', answer.generatedAt], ['Correlation ID', code(answer.correlationId)], ['Request ID', code(answer.requestId)]],
    'fields fields-compact'));
  return out;
}
