import type { PrismaClient } from '@prisma/client';
import { powerOfficeError } from './contracts.ts';
import type { PowerOfficeErrorCode } from './contracts.ts';
import { powerOfficeFailure } from './authority.ts';
import type { PowerOfficeCredential } from './authority.ts';
import { admitSync } from './admission.ts';
import { endClaim } from './capabilities.ts';
import { runExportPass } from './pass.ts';
import { publishFact } from './publication.ts';
import type { PowerOfficeSyncReceipt } from './publication.ts';
import { closeFailed } from './failure.ts';

/**
 * Manual synchronization (docs/stage4/04_PORT_AND_SYNC.md "Manual synchronization"): admission (admission.ts) → one export
 * pass with fresh page admissions (pass.ts) → atomic publication of the same complete fact (publication.ts). The public
 * service takes only the trusted composition, the private bearer credential and the explicit client/connection — never
 * an Actor, DTO, port, callback, script, file, URL, tenant or clock. It returns a receipt without financial data.
 *
 * A pass that ends without a complete export, and a publication POSITIVELY refused by lost caller authority or a binding
 * change (nothing committed), close the owned claim through the private failure continuation (failure.ts) with that fixed
 * code; the visible error is that code, or the continuation's own fixed error when the closure could not be recorded
 * (the claim then stays ACTIVE for explicit recovery). Infrastructure failures (DB conflict, readiness, audit, timeout,
 * unknown outcome), a stale claim, a publication refused at/after the claim deadline and every other publication failure
 * leave the claim as it is — never a false failure, a claimed success or a new export. Nothing is retried beyond the
 * bounded known-rollback rule of publication and the failure continuation.
 */
const SOURCE_STOP: ReadonlySet<PowerOfficeErrorCode> = new Set(['POWEROFFICE_SOURCE_FAILED', 'POWEROFFICE_DTO_INVALID', 'POWEROFFICE_EXPORT_INCOMPLETE',
  'POWEROFFICE_DEADLINE', 'POWEROFFICE_AUTHENTICATION_FAILED', 'SCOPE_DENIED', 'PERMISSION_DENIED', 'POWEROFFICE_CONNECTION_UNAVAILABLE',
  'POWEROFFICE_BINDING_CHANGED']);
const PUBLICATION_REFUSED: ReadonlySet<PowerOfficeErrorCode> = new Set(['POWEROFFICE_AUTHENTICATION_FAILED', 'SCOPE_DENIED', 'PERMISSION_DENIED',
  'POWEROFFICE_CONNECTION_UNAVAILABLE', 'POWEROFFICE_BINDING_CHANGED']);

export async function syncPowerOffice(db: PrismaClient, composition: unknown, credential: PowerOfficeCredential, clientId: string,
  connectionId: string): Promise<PowerOfficeSyncReceipt> {
  const admitted = await admitSync(db, composition, credential, clientId, connectionId);
  const close = async (code: PowerOfficeErrorCode): Promise<never> => {
    try { await closeFailed(db, admitted.failure, code); } catch (error) { throw powerOfficeFailure(error); }
    throw powerOfficeError(code);
  };
  try {
    const pass = await runExportPass(db, admitted.claim);
    if (!pass.complete) {
      if (SOURCE_STOP.has(pass.code)) return await close(pass.code);
      throw powerOfficeError(pass.code);
    }
    try { return await publishFact(db, admitted.claim, pass.summary); }
    catch (error) {
      const code = powerOfficeFailure(error).code as PowerOfficeErrorCode;
      if (PUBLICATION_REFUSED.has(code)) return await close(code);
      throw powerOfficeError(code);
    }
  } finally {
    endClaim(admitted.claim);
  }
}
