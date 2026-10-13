import { Controller, Get, HttpCode, Inject, Module, Post, Req, Res } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { RemoteCircuit } from '../../../../packages/ask/remote/circuit.ts';
import { dbRemotePort } from '../../../../packages/ask/remote/db.ts';
import { productionSeams } from '../../../../packages/ask/remote/secret.ts';
import type { RemoteSeams } from '../../../../packages/ask/remote/secret.ts';
import { runRemoteCapability, runRemoteQuestion } from '../../../../packages/ask/remote/service.ts';
import type { RemoteDeps } from '../../../../packages/ask/remote/service.ts';
import { serveAsk } from '../ask-http.ts';
import { PRISMA } from './database.ts';

/** Nest injection token of the private provider seams; production binds productionSeams(), only in-process tests pass others. */
export const ASK_REMOTE_SEAMS = 'atlas.ask.remote.seams';

/**
 * DB Ask routes in ATLAS_ASK_MODE=remote (docs/stage5/ask/remote/02): the SAME two routes, ingress, private bearer and
 * fixed envelope as MOCK, serving AskCapabilityV2 / AskRequestV2 / AskAnswerV2 through packages/ask/remote. One local
 * configuration-fault circuit per process. Composing this module reads no secret and makes no provider call; every
 * request is gated by the durable workspace policy, client admission and the actor's context:read+ask:remote membership.
 */
@Controller()
export class AskRemoteDbController {
  readonly #deps: RemoteDeps;
  constructor(@Inject(PRISMA) db: PrismaClient, @Inject(ASK_REMOTE_SEAMS) seams: RemoteSeams) {
    this.#deps = Object.freeze({ port: dbRemotePort(db), seams, circuit: new RemoteCircuit() });
  }
  @Get('ask/capabilities') capabilities(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    serveAsk(req, res, 'capability', run => runRemoteCapability(run, this.#deps, req.headers.authorization));
  }
  /** The client ID is the Ask-owned value from the private ingress state (never a re-routed Express parameter). */
  @Post('clients/:id/ask') @HttpCode(200) ask(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    serveAsk(req, res, 'question', (run, body, clientId, evaluation) => runRemoteQuestion(run, this.#deps,
      { authorization: req.headers.authorization, clientId, body, ...(evaluation ? { evaluation } : {}) }));
  }
}

/** Composed by AtlasDbModule only in REMOTE. `seams` is the in-process offline test seam; production uses productionSeams(). */
@Module({})
export class AskRemoteDbModule {
  static forSeams(seams?: RemoteSeams): DynamicModule {
    return { module: AskRemoteDbModule, controllers: [AskRemoteDbController],
      providers: [{ provide: ASK_REMOTE_SEAMS, useFactory: () => seams ?? productionSeams() }] };
  }
}
