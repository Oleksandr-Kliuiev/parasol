import type pg from 'pg';
import type { PrismaClient } from '@prisma/client';
import { powerOfficeCredential } from '../../packages/poweroffice/authority.ts';
import { POWEROFFICE_MODE_VARIABLE, powerOfficeComposition } from '../../packages/poweroffice/composition.ts';
import { admitSync } from '../../packages/poweroffice/admission.ts';
import type { Admitted } from '../../packages/poweroffice/admission.ts';
import { runExportPass } from '../../packages/poweroffice/pass.ts';
import { publishFact } from '../../packages/poweroffice/publication.ts';
import { endClaim } from '../../packages/poweroffice/capabilities.ts';
import { syncPowerOffice } from '../../packages/poweroffice/sync.ts';
import { readPowerOfficeStatus, readPowerOfficeSummary } from '../../packages/poweroffice/read.ts';
import { tokens } from './poweroffice-fixtures.ts';
import { codeOf, seam } from './poweroffice-sync.ts';

/**
 * S4-C TRUSTED TEST SUPPORT for the dedicated reads: the real MOCK composition, credentials of the synthetic actors, an
 * ACTIVE claim left open (actual admission, no pass), its later completion through the accepted pass/publication, a failing
 * source through the private fault seam, and observers of read audit rows (owner). No production path uses any of it.
 */
export const MOCK = powerOfficeComposition({ [POWEROFFICE_MODE_VARIABLE]: 'MOCK' });
export const as = (actor: string) => powerOfficeCredential(tokens[actor]!);
export const summaryOf = (db: PrismaClient, connectionId: string, clientId: string, actor = 'reader') =>
  readPowerOfficeSummary(db, MOCK, as(actor), clientId, connectionId);
export const statusOf = (db: PrismaClient, connectionId: string, clientId: string, actor = 'reader') =>
  readPowerOfficeStatus(db, MOCK, as(actor), clientId, connectionId);

/** A real admitted ACTIVE claim of the syncer whose pass has not run (left open for precedence/recovery cases). */
export const openClaim = (db: PrismaClient, clientId: string, connectionId: string): Promise<Admitted> => admitSync(db, MOCK, as('syncer'), clientId, connectionId);
/** Completes an open claim through the accepted pass + publication (fresh authority each step). */
export async function completeClaim(db: PrismaClient, admitted: Admitted) {
  try {
    const pass = await runExportPass(db, admitted.claim);
    if (!pass.complete) throw new Error(`pass incomplete: ${pass.code}`);
    return await publishFact(db, admitted.claim, pass.summary);
  } finally { endClaim(admitted.claim); }
}
/** One explicit sync whose source fails (private fault seam): the claim closes FAILED with POWEROFFICE_SOURCE_FAILED. */
export const failingSync = (db: PrismaClient, clientId: string, connectionId: string) =>
  codeOf(syncPowerOffice(db, seam(async () => { throw new Error('synthetic source down'); }).composition, as('syncer'), clientId, connectionId));
export const goodSync = (db: PrismaClient, clientId: string, connectionId: string) => syncPowerOffice(db, MOCK, as('syncer'), clientId, connectionId);

/** Read audit rows (owner observation), oldest first. */
export async function readAudits(owner: pg.Client, connectionId?: string) {
  return (await owner.query(`SELECT "clientId", "actorId", "eventType", metadata FROM "AuditEvent" WHERE "eventType" IN ('poweroffice.status.read', 'poweroffice.summary.read')
    ${connectionId ? `AND metadata->>'connectionId' = $1` : ''} ORDER BY "recordedAt", id`, connectionId ? [connectionId] : [])).rows;
}
export async function counts(owner: pg.Client) {
  return (await owner.query(`SELECT (SELECT count(*)::int FROM "AuditEvent") AS audits, (SELECT count(*)::int FROM "SecurityAuditEvent") AS denials,
    (SELECT count(*)::int FROM "PowerOfficeState") AS states, (SELECT count(*)::int FROM "ToolExecution") AS executions`)).rows[0] as
    { audits: number; denials: number; states: number; executions: number };
}
