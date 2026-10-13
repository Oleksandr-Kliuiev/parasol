import { Controller, Get, HttpCode, Inject, Module, Post, Req, Res } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { dbAskPort } from '../../../../packages/ask/authority.ts';
import { ASK_PLANNER, MOCK_PLANNER } from '../../../../packages/ask/planner.ts';
import type { AskPlanner } from '../../../../packages/ask/planner.ts';
import { runCapability, runQuestion } from '../../../../packages/ask/service.ts';
import type { AskPort } from '../../../../packages/ask/service.ts';
import { serveAsk } from '../ask-http.ts';
import { PRISMA } from './database.ts';

/**
 * DB Ask routes (ATLAS_ASK_MODE=mock only, docs/stage5/ask): Ask-private bounded authentication and two-phase fenced
 * current authority over the confined runtime role (packages/ask/authority.ts). No ApiTokenGuard, no @Body(): the private
 * parsed body comes from the Ask ingress; every reply (including 401) is the fixed AskErrorV1/answer DTO.
 */
@Controller()
export class AskDbController {
  readonly #port: AskPort;
  readonly #planner: AskPlanner;
  constructor(@Inject(PRISMA) db: PrismaClient, @Inject(ASK_PLANNER) planner: AskPlanner) {
    this.#planner = planner;
    this.#port = dbAskPort(db);
  }
  @Get('ask/capabilities') capabilities(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    serveAsk(req, res, 'capability', run => runCapability(run, this.#port, req.headers.authorization));
  }
  /** The client ID is the Ask-owned value from the private ingress state (never a re-routed Express parameter). */
  @Post('clients/:id/ask') @HttpCode(200) ask(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    serveAsk(req, res, 'question', (run, body, clientId) => runQuestion(run, this.#port, this.#planner, { authorization: req.headers.authorization, clientId, body }));
  }
}

/** Composed by AtlasDbModule only in MOCK. The planner is the local MOCK unless an in-process test module passes another. */
@Module({})
export class AskDbModule {
  static forPlanner(planner: AskPlanner = MOCK_PLANNER): DynamicModule {
    return { module: AskDbModule, controllers: [AskDbController], providers: [{ provide: ASK_PLANNER, useValue: planner }] };
  }
}
