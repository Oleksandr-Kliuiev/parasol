// Selected observation: source identifiers, severity/urgency, priority, route, confidence (explanatory), reason codes,
// lifecycle times, confirmed entity or an unresolved/unavailable label, conflict/superseded references as text only (no
// cross-client navigation), and the evidence action. Selecting an observation never reads evidence by itself.
import { button, el, untrusted } from './dom.ts';
import { resolveEntity } from './entities.ts';
import type { EntityResolution } from './entities.ts';
import { planEvidence } from './evidence-plan.ts';
import type { EvidencePlan } from './evidence-plan.ts';
import { CONFIDENCE_NOTE, ENTITY_TEXT, EVIDENCE_HINT, EVIDENCE_TOOL_LABEL, EVIDENCE_UNAVAILABLE_TEXT, URGENT_DETAIL, urgentText } from './messages.ts';
import type { ContextView, LinkView, ObservationItem } from './contracts.ts';
import { code, fields, isUrgent, severityNodes, timeText } from './view-parts.ts';
import type { Controller } from './controller.ts';

function linkText(link: LinkView): (Node | string)[] {
  return [`${link.system} ${link.resourceType} `, code(link.externalId)];
}

function entity(resolution: EntityResolution): (Node | string)[] {
  switch (resolution.kind) {
    case 'UNRESOLVED': return [ENTITY_TEXT.UNRESOLVED];
    case 'UNAVAILABLE': return [ENTITY_TEXT.UNAVAILABLE, ' Stored reference ', code(resolution.entityId), '.'];
    case 'PERSON': return [el('strong', null, 'Confirmed person: '), ...untrusted(resolution.person.displayName), ' via ',
      ...resolution.links.flatMap((l, i) => [...(i ? ['; '] : []), ...linkText(l)])];
    case 'DEVICE': {
      const person = resolution.person.kind === 'RESOLVED' ? ['; stored person reference: ', ...untrusted(resolution.person.person.displayName)]
        : resolution.person.kind === 'UNAVAILABLE' ? [`; ${ENTITY_TEXT.PERSON_UNAVAILABLE}`] : [];
      return [el('strong', null, 'Confirmed device: '), ...untrusted(resolution.device.hostname), ' via ',
        ...resolution.links.flatMap((l, i) => [...(i ? ['; '] : []), ...linkText(l)]), ...person];
    }
  }
}

export function observationDetail(item: ObservationItem, context: ContextView): Node[] {
  const urgent = isUrgent(item.severity);
  const out: Node[] = [el('h3', 'detail-title', ...untrusted(item.summary))];
  if (urgent) out.push(el('p', 'notice notice-urgent', el('strong', null, urgentText(item.severity)), '. ', URGENT_DETAIL));
  out.push(fields([
    ['Source severity', severityNodes(item.severity)],
    ['Priority label', item.priority],
    ['Route', item.route],
    ['Confidence', `${Math.round(item.confidence * 100)}% (${CONFIDENCE_NOTE})`],
    ['Decided by', item.provider],
    ['Reason codes', item.reasonCodes.length ? el('ul', 'codes', ...item.reasonCodes.map(c => el('li', null, code(c)))) : 'none'],
    ['Lifecycle status', item.status],
    ['Acknowledged', item.acknowledgedAt ?? 'not acknowledged'],
    ['Resolved', item.resolvedAt ?? 'not resolved'],
    ['Kind / domain', `${item.kind} / ${item.domain}`],
    ['Entity', entity(resolveEntity(context, item.entityId))],
    ['Source', `${item.source} ${item.resourceType}`],
    ['Connection', code(item.connectionId)],
    ['Source event ID', code(item.externalEventId)],
    ['Revision', untrusted(item.revision)],
    ['Event key', code(item.eventKey)],
    ['Decision run', item.decisionRunId === null ? 'none' : code(item.decisionRunId)],
    ['Conflict', item.conflictOfEventKey === null ? 'none' : ['Conflicting revision of stored event ', code(item.conflictOfEventKey), ' (text reference only)']],
    ['Superseded', item.supersededById === null ? 'not superseded' : ['Superseded by observation ', code(item.supersededById), ' (text reference only)']],
    ['Occurred', timeText(item.occurredAt)], ['Created', item.createdAt], ['Updated', item.updatedAt]
  ], 'fields detail-fields'));
  return out;
}

/** The evidence action for one selection: the named allowlisted read, or why there is none (no request either way). */
export function evidenceAction(item: ObservationItem, clientId: string, context: ContextView, controller: Controller): { nodes: Node[]; button: HTMLButtonElement | null } {
  const plan: EvidencePlan = planEvidence(item, clientId, context.mode);
  if (plan.kind === 'unavailable') return { nodes: [el('p', 'notice notice-info', EVIDENCE_UNAVAILABLE_TEXT[plan.reason])], button: null };
  const action = button(EVIDENCE_TOOL_LABEL[plan.target.tool], 'btn btn-primary', () => controller.requestEvidence());
  const meta = el('p', 'muted small', 'Tool ', code(plan.target.tool), ' · connection ', code(plan.target.connectionId), ' · source ID ', code(plan.target.sourceId));
  return { nodes: [action, meta, el('p', 'muted small', EVIDENCE_HINT)], button: action };
}
