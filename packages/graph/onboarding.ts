import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Actor, Scope } from '../core/contracts.ts';
import { assertPermission, M365_READ } from '../core/contracts.ts';
import { withScope } from './scoped-db.ts';
import { confirmLink, proposeLink } from './mapping.ts';

/**
 * Client onboarding of the canonical graph (owner decision 2026-10-13; docs/deploy/DEPLOY.md "Onboarding"). Until now only the
 * synthetic seed created canonical people and devices. This step creates them FROM source identity objects and links each object
 * to the entity made from it through the accepted mapping workflow (proposeLink + confirmLink: mapping:review, m365:read for
 * M365 objects, fresh directory evidence, audited):
 * - every enabled MEMBER user of the active Microsoft 365 directory generation → a Person (display name, UPN as email);
 * - every enabled Microsoft 365 device → a Device (display name as hostname);
 * - an agent (Atera/Huntress) whose hostname equals exactly ONE planned or existing device (case-insensitive) → a CANDIDATE link
 *   to that device only — a name never proves identity, so a person confirms it in the mapping review queue;
 * - an agent without such a device → a Device made from it, linked and confirmed (the entity IS that object).
 * Guests, disabled users and objects that already carry a confirmed link are skipped. Idempotent. Without `apply` it only plans.
 */
export interface OnboardSummary {
  apply: boolean;
  people: { planned: number; skippedGuests: number; skippedDisabled: number; alreadyLinked: number };
  devices: { plannedFromM365: number; plannedFromAgents: number; alreadyLinked: number };
  candidates: { agentHostname: string; deviceHostname: string; status: string }[];
  ambiguousAgents: number;
  created: { people: number; devices: number; confirmedLinks: number; candidateLinks: number };
}
interface Row { externalEntityId: string | null; dto: Record<string, unknown> }
const newId = (prefix: 'p' | 'd') => `${prefix}-${randomBytes(8).toString('hex')}`;
const norm = (s: string) => s.trim().toLowerCase();

export async function onboardClient(db: PrismaClient, actor: Actor, scope: Scope, options: { apply: boolean }): Promise<OnboardSummary> {
  for (const permission of ['mapping:review', 'context:read', M365_READ]) assertPermission(actor, scope, permission);
  const ids = { workspaceId: scope.workspaceId, clientId: scope.clientId };
  const state = await withScope(db, actor, [ids.clientId], async tx => {
    const directory = (resourceType: string) => tx.$queryRaw<Row[]>`SELECT o."externalEntityId", o.dto FROM "M365DirectoryObject" o
      JOIN "M365ResourceState" s ON s."workspaceId" = o."workspaceId" AND s."clientId" = o."clientId" AND s."connectionId" = o."connectionId"
        AND s."resourceType" = o."resourceType" AND s."activeGenerationId" = o."generationId"
      WHERE o."workspaceId" = ${ids.workspaceId} AND o."clientId" = ${ids.clientId} AND o."resourceType" = ${resourceType}
      ORDER BY o."sourceObjectId"`;
    const confirmed = new Set((await tx.entityLink.findMany({ where: { ...ids, status: 'CONFIRMED' }, select: { externalEntityId: true } })).map(l => l.externalEntityId));
    const agents = await tx.externalEntity.findMany({ where: { ...ids, resourceType: 'agent' }, select: { id: true, attributes: true }, orderBy: { id: 'asc' } });
    const devices = await tx.device.findMany({ where: ids, select: { id: true, hostname: true } });
    return { users: await directory('m365_user'), m365Devices: await directory('m365_device'), agents, devices, confirmed };
  });

  const summary: OnboardSummary = { apply: options.apply, people: { planned: 0, skippedGuests: 0, skippedDisabled: 0, alreadyLinked: 0 },
    devices: { plannedFromM365: 0, plannedFromAgents: 0, alreadyLinked: 0 }, candidates: [], ambiguousAgents: 0,
    created: { people: 0, devices: 0, confirmedLinks: 0, candidateLinks: 0 } };
  const people: { ext: string; displayName: string; email: string | null }[] = [];
  for (const u of state.users) {
    if (!u.externalEntityId) continue;
    if (state.confirmed.has(u.externalEntityId)) { summary.people.alreadyLinked += 1; continue; }
    if (u.dto.userType !== 'Member') { summary.people.skippedGuests += 1; continue; }
    if (u.dto.accountEnabled !== true) { summary.people.skippedDisabled += 1; continue; }
    const upn = typeof u.dto.userPrincipalName === 'string' ? u.dto.userPrincipalName.toLowerCase() : null;
    people.push({ ext: u.externalEntityId, displayName: String(u.dto.displayName ?? upn ?? 'Microsoft 365 user').slice(0, 200), email: upn });
  }
  summary.people.planned = people.length;
  // Devices: M365 first (they are the hostname targets of agent candidates), then agents.
  const planned: { ext: string; hostname: string; id: string; existing: boolean }[] = [];
  for (const d of state.m365Devices) {
    if (!d.externalEntityId) continue;
    if (state.confirmed.has(d.externalEntityId)) { summary.devices.alreadyLinked += 1; continue; }
    if (d.dto.accountEnabled === false) continue;
    planned.push({ ext: d.externalEntityId, hostname: String(d.dto.displayName ?? d.dto.deviceId ?? d.dto.id).slice(0, 200), id: newId('d'), existing: false });
  }
  summary.devices.plannedFromM365 = planned.length;
  const targets = [...state.devices.map(d => ({ id: d.id, hostname: d.hostname })), ...planned.map(p => ({ id: p.id, hostname: p.hostname }))];
  const candidates: { ext: string; entityId: string; agentHostname: string; deviceHostname: string }[] = [];
  const fromAgents: typeof planned = [];
  for (const a of state.agents) {
    if (state.confirmed.has(a.id)) { summary.devices.alreadyLinked += 1; continue; }
    const hostname = typeof (a.attributes as Record<string, unknown>)?.hostname === 'string' ? (a.attributes as Record<string, string>).hostname! : null;
    const matches = hostname ? targets.filter(t => norm(t.hostname) === norm(hostname)) : [];
    if (matches.length === 1) candidates.push({ ext: a.id, entityId: matches[0]!.id, agentHostname: hostname!, deviceHostname: matches[0]!.hostname });
    else if (matches.length > 1) summary.ambiguousAgents += 1;
    else fromAgents.push({ ext: a.id, hostname: hostname ?? `agent-${a.id.slice(0, 8)}`, id: newId('d'), existing: false });
  }
  summary.devices.plannedFromAgents = fromAgents.length;
  summary.candidates = candidates.map(c => ({ agentHostname: c.agentHostname, deviceHostname: c.deviceHostname, status: options.apply ? 'CANDIDATE' : 'PLANNED' }));
  if (!options.apply) return summary;

  const link = async (ext: string, entityId: string) => {
    const proposed = await proposeLink(db, actor, scope, { externalEntityId: ext, entityId });
    const decided = proposed.status === 'CONFIRMED' ? proposed : await confirmLink(db, actor, scope, proposed.linkId);
    if (decided.status === 'CONFIRMED') summary.created.confirmedLinks += 1;
  };
  for (const p of people) {
    const id = newId('p');
    await withScope(db, actor, [ids.clientId], async tx => {
      await tx.entity.create({ data: { ...ids, id, kind: 'PERSON' }, select: { id: true } });
      await tx.person.create({ data: { ...ids, id, displayName: p.displayName, email: p.email }, select: { id: true } });
    });
    summary.created.people += 1;
    await link(p.ext, id);
  }
  for (const d of [...planned, ...fromAgents]) {
    await withScope(db, actor, [ids.clientId], async tx => {
      await tx.entity.create({ data: { ...ids, id: d.id, kind: 'DEVICE' }, select: { id: true } });
      await tx.device.create({ data: { ...ids, id: d.id, hostname: d.hostname }, select: { id: true } });
    });
    summary.created.devices += 1;
    await link(d.ext, d.id);
  }
  for (const c of candidates) {
    const proposed = await proposeLink(db, actor, scope, { externalEntityId: c.ext, entityId: c.entityId });
    if (proposed.status === 'CANDIDATE') summary.created.candidateLinks += 1;
  }
  return summary;
}
