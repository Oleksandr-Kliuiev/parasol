import { Controller, Get, Inject, Module, Param, Req, Res } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { parseBearerToken } from '../../../../packages/auth/token.ts';
import { AtlasError } from '../../../../packages/core/contracts.ts';
import { isPowerOfficeErrorCode } from '../../../../packages/poweroffice/contracts.ts';
import type { PowerOfficeErrorCode } from '../../../../packages/poweroffice/contracts.ts';
import { powerOfficeCredential, powerOfficeFailure } from '../../../../packages/poweroffice/authority.ts';
import { powerOfficeComposition } from '../../../../packages/poweroffice/composition.ts';
import { readPowerOfficeStatus, readPowerOfficeSummary } from '../../../../packages/poweroffice/read.ts';
import { PRISMA } from './database.ts';

/**
 * GET /clients/:clientId/poweroffice/:connectionId/status and /summary (docs/stage4/02_CONTRACTS.md "Public interface",
 * IMPLEMENTATION_HANDOFF.md item 5). A route-specific dispatch: NOT the legacy ApiTokenGuard/Actor path, Gateway, tool
 * readers or ToolExecution ledger. The Authorization bearer becomes an opaque private PowerOffice credential (its digest
 * only) and goes straight to the read service, which alone owns fresh authority, the workspace denial audit and the atomic
 * read audit. This adapter only parses and maps fixed codes to fixed synthetic envelopes: missing/malformed/unknown/expired
 * bearer 401, scope/permission 403, unknown/invisible/non-PowerOffice connection 404, busy/conflict 409, mode/readiness 503;
 * an authorized read of an invalid binding/lifecycle answers 503 WITH its strict UNAVAILABLE read DTO (null summary); every
 * other precedence row 200. Any query parameter is a 400. Every response is Cache-Control: no-store and carries
 * synthetic:true. Nothing is logged: no token, digest, SQL, cause or input echo.
 */
export const POWEROFFICE_COMPOSITION = 'atlas.poweroffice.composition';
/** The composition of this process (from its environment, once), or the fixed code refusing it (DISABLED by default). */
export type CompositionSlot = { composition: unknown } | { refused: PowerOfficeErrorCode };
export function compositionSlot(env: Readonly<Record<string, string | undefined>>): CompositionSlot {
  try { return { composition: powerOfficeComposition(env) }; }
  catch (error) { return { refused: powerOfficeFailure(error).code as PowerOfficeErrorCode }; }
}

const STATUS: Partial<Record<PowerOfficeErrorCode, number>> = {
  POWEROFFICE_AUTHENTICATION_FAILED: 401, SCOPE_DENIED: 403, PERMISSION_DENIED: 403, POWEROFFICE_NOT_FOUND: 404, INVALID_ARGUMENTS: 400,
  POWEROFFICE_SYNC_BUSY: 409, POWEROFFICE_DB_CONFLICT: 409, POWEROFFICE_PUBLICATION_CONFLICT: 409, POWEROFFICE_CLAIM_STALE: 409,
  POWEROFFICE_DISABLED: 503, POWEROFFICE_MODE_UNSUPPORTED: 503, POWEROFFICE_RUNTIME_NOT_READY: 503,
  POWEROFFICE_CONNECTION_UNAVAILABLE: 503, POWEROFFICE_BINDING_CHANGED: 503,
};
/** HTTP status of a fixed code; audit failure and anything unexpected are 500 with their fixed code only. */
export const powerOfficeHttpStatus = (code: PowerOfficeErrorCode): number => STATUS[code] ?? 500;
/** Fixed code of any failure (never a message, detail or SQLSTATE). */
export function powerOfficeHttpCode(error: unknown): PowerOfficeErrorCode {
  const fixed = powerOfficeFailure(error);
  return fixed instanceof AtlasError && isPowerOfficeErrorCode(fixed.code) ? fixed.code : 'UNEXPECTED_ERROR';
}

interface Request { headers: Record<string, unknown>; query: unknown }
interface Response { status(code: number): Response; setHeader(name: string, value: string): unknown; json(body: unknown): unknown }
function send(res: Response, status: number, body: object): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}
const fail = (res: Response, code: PowerOfficeErrorCode) => send(res, powerOfficeHttpStatus(code), { statusCode: powerOfficeHttpStatus(code), code, synthetic: true });

@Controller('clients')
export class PowerOfficeController {
  constructor(@Inject(PRISMA) private readonly db: PrismaClient, @Inject(POWEROFFICE_COMPOSITION) private readonly slot: CompositionSlot) {}

  @Get(':clientId/poweroffice/:connectionId/status')
  async status(@Param('clientId') clientId: string, @Param('connectionId') connectionId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.dispatch(req, res, clientId, connectionId, readPowerOfficeStatus);
  }
  @Get(':clientId/poweroffice/:connectionId/summary')
  async summary(@Param('clientId') clientId: string, @Param('connectionId') connectionId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.dispatch(req, res, clientId, connectionId, readPowerOfficeSummary);
  }

  private async dispatch(req: Request, res: Response, clientId: string, connectionId: string,
    read: (db: PrismaClient, composition: unknown, credential: ReturnType<typeof powerOfficeCredential>, clientId: string, connectionId: string) => Promise<{ status: string }>): Promise<void> {
    const token = parseBearerToken(req.headers.authorization);
    if (token === null) return fail(res, 'POWEROFFICE_AUTHENTICATION_FAILED');
    const query = req.query;
    if (query !== undefined && query !== null && (typeof query !== 'object' || Object.keys(query).length > 0)) return fail(res, 'INVALID_ARGUMENTS');
    if ('refused' in this.slot) return fail(res, this.slot.refused);
    try {
      const dto = await read(this.db, this.slot.composition, powerOfficeCredential(token), clientId, connectionId);
      send(res, dto.status === 'UNAVAILABLE' ? 503 : 200, dto);
    } catch (error) {
      fail(res, powerOfficeHttpCode(error));
    }
  }
}

@Module({ controllers: [PowerOfficeController], providers: [{ provide: POWEROFFICE_COMPOSITION, useFactory: () => compositionSlot(process.env) }] })
export class PowerOfficeModule {}
