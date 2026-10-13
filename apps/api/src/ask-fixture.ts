import { Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { actor, scope } from '../../../fixtures/gasta.ts';
import type { DemoResult } from '../../../fixtures/run-demo.ts';
import { fixtureAskPort } from '../../../packages/ask/fixture.ts';
import { ASK_PLANNER } from '../../../packages/ask/planner.ts';
import type { AskPlanner } from '../../../packages/ask/planner.ts';
import { runCapability, runQuestion } from '../../../packages/ask/service.ts';
import type { AskPort } from '../../../packages/ask/service.ts';
import { serveAsk } from './ask-http.ts';

/** Injection token of the fixture demo (the same FixtureContextService instance: one synthetic context and memory audit). */
export const ASK_FIXTURE_DEMO = 'atlas.ask.fixture-demo';

/**
 * Fixture Ask routes (ATLAS_ASK_MODE=mock only, docs/stage5/ask): synthetic equality-token authority of the demo actor,
 * the demo context as source, its memory audit. No shared guard: the Ask-private boundary owns authentication and errors.
 */
@Controller()
export class AskFixtureController {
  readonly #port: AskPort;
  readonly #planner: AskPlanner;
  constructor(@Inject(ASK_FIXTURE_DEMO) source: { readonly demo: Promise<DemoResult> }, @Inject(ASK_PLANNER) planner: AskPlanner) {
    this.#planner = planner;
    this.#port = fixtureAskPort({ demo: () => source.demo, demoToken: () => process.env.ATLAS_DEMO_TOKEN, actor, scope });
  }
  @Get('ask/capabilities') capabilities(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    serveAsk(req, res, 'capability', run => runCapability(run, this.#port, req.headers.authorization));
  }
  /** The client ID is the Ask-owned value from the private ingress state (never a re-routed Express parameter). */
  @Post('clients/:id/ask') @HttpCode(200) ask(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    serveAsk(req, res, 'question', (run, body, clientId) => runQuestion(run, this.#port, this.#planner, { authorization: req.headers.authorization, clientId, body }));
  }
}
