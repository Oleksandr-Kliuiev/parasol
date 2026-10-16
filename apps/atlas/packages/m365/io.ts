import type { PrismaClient, Prisma } from '@prisma/client';
import type { Actor } from '../core/contracts.ts';
import type { SecretResolver } from '../../connectors/contracts.ts';
import { ClientCredentialsTokenProvider } from '../../connectors/microsoft365/auth.ts';
import type { TokenProvider } from '../../connectors/microsoft365/auth.ts';
import { M365GraphSession } from '../../connectors/microsoft365/connector.ts';
import { fetchAuthTransport, fetchGraphTransport } from '../../connectors/microsoft365/http.ts';
import type { GraphTransport } from '../../connectors/microsoft365/http.ts';
import { graphAuthority } from './authority.ts';
import type { M365Pin } from './authority.ts';

/**
 * Composition of the M365 services: the GET-only Graph transport, the token provider (POST-only authority transport) and
 * the secret resolver are injected, so tests run against captured mocks and only the production composition uses fetch.
 * The clock is read by the services after their locks (decision time), and by the Graph session for token expiry.
 */
export interface M365Io { graph: GraphTransport; tokens: TokenProvider; secrets: SecretResolver }
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function productionM365Io(secrets: SecretResolver): M365Io {
  return { graph: fetchGraphTransport, tokens: new ClientCredentialsTokenProvider(fetchAuthTransport), secrets };
}
export function openSession(db: PrismaClient, actor: Actor, pin: M365Pin, io: M365Io, clock: Clock,
  claimCheck?: (tx: Prisma.TransactionClient) => Promise<void>): M365GraphSession {
  return new M365GraphSession(graphAuthority(db, actor, pin, io.secrets, claimCheck), { graph: io.graph, tokens: io.tokens }, () => clock().getTime());
}
export const plusMs = (date: Date, ms: number): Date => new Date(date.getTime() + ms);
