import type { Severity, SnapshotItem } from '../../packages/core/contracts.ts';
import type { IdentityRead } from '../contracts.ts';
import { record, list, id, count, optionalText, oneOf, optionalTime, contractMismatch } from '../dto.ts';

/**
 * Atera API v3 contract as Atlas reads it. Source: "Atera OpenAPI v3 documentation" (OpenAPI 3.0.4) as exported into the
 * public repository davejlong/PSAtera (atera-openapi.yaml, committed 2026-06-16). The vendor's own reference
 * (app.atera.com/apidocs) requires an account login and was NOT available: this contract is UNVERIFIED against the
 * account and must be confirmed before a live connection is activated (checklist in connectors/CONTRACTS.md). Runtime
 * validation fails closed (UPSTREAM_CONTRACT_MISMATCH), so a difference shows as an ERROR resource, never as wrong data.
 */
export const ATERA_CONTRACT_VERSION = 'atera-api-v3/openapi-export-2026-06-16/unverified';
export const ATERA_BASE_URL = 'https://app.atera.com';
/** Atlas mapping of the documented alert severities (not used while alerts are unavailable; kept with the contract). */
export const ATERA_ALERT_SEVERITIES = ['Information', 'Warning', 'Critical'] as const;
export const ateraAlertSeverity: Readonly<Record<(typeof ATERA_ALERT_SEVERITIES)[number], Severity>> = Object.freeze({ Information: 'INFO', Warning: 'MEDIUM', Critical: 'CRITICAL' });
export const ATERA_TICKET_PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const;
/** Atera timestamps in the export carry no zone; interpreted as UTC until verified against the account. */
const ASSUME_UTC = true;

export interface AteraPage<T> { items: T[]; page: number; totalPages: number; totalItemCount: number }
/** Paged envelope (TicketDtoPagedResult, AgentDtoPagedResult): items (nullable), page, totalPages, totalItemCount. */
export function parsePage<T>(body: unknown, item: (value: unknown) => T): AteraPage<T> {
  const root = record(body, 'root');
  const items = root.items === null ? [] : list(root.items, 'items').map(item);
  return { items, page: count(root.page, 'page'), totalPages: count(root.totalPages, 'totalPages'), totalItemCount: count(root.totalItemCount, 'totalItemCount') };
}

export interface AteraTicket { id: string; customerId: string; title: string | null; status: string; priority: (typeof ATERA_TICKET_PRIORITIES)[number]; createdAt: string | null }
export function parseTicket(value: unknown): AteraTicket {
  const t = record(value, 'items[]');
  const status = optionalText(t.TicketStatus, 'ticket.TicketStatus', 40);
  if (status === null) throw contractMismatch('ticket.TicketStatus');
  return { id: id(t.TicketID, 'ticket.TicketID'), customerId: id(t.CustomerID, 'ticket.CustomerID'), title: optionalText(t.TicketTitle, 'ticket.TicketTitle', 200),
    status, priority: oneOf(t.TicketPriority, 'ticket.TicketPriority', ATERA_TICKET_PRIORITIES),
    createdAt: optionalTime(t.TicketCreatedDate, 'ticket.TicketCreatedDate', ASSUME_UTC) };
}

export interface AteraAgent { id: string; customerId: string; machineName: string | null; osType: string | null; modified: string | null }
export function parseAgent(value: unknown): AteraAgent {
  const a = record(value, 'items[]');
  return { id: id(a.AgentID, 'agent.AgentID'), customerId: id(a.CustomerID, 'agent.CustomerID'),
    machineName: optionalText(a.MachineName, 'agent.MachineName', 255), osType: optionalText(a.OSType, 'agent.OSType', 32),
    modified: optionalTime(a.Modified, 'agent.Modified', ASSUME_UTC) };
}

/** GET /api/v3/customers/{customerId} → CustomerDto. */
export function parseCustomerId(body: unknown): string {
  return id(record(body, 'root').CustomerID, 'customer.CustomerID');
}

export function ticketItem(t: AteraTicket): SnapshotItem {
  return { source: 'atera', resourceType: 'ticket', externalId: t.id, title: t.title ?? 'Atera ticket', status: t.status, severity: null,
    priority: t.priority, device: null, occurredAt: t.createdAt, updatedAt: null };
}
/** MachineName is the computer name, the evidence the hostname matcher compares (never proof of identity by itself). */
export function agentIdentity(a: AteraAgent, fetchedAt: string): IdentityRead {
  const attributes: Record<string, string> = {};
  if (a.machineName) attributes.hostname = a.machineName;
  if (a.osType) attributes.osType = a.osType;
  return { resourceType: 'agent', externalId: a.id, attributes, observedAt: a.modified ?? fetchedAt };
}
