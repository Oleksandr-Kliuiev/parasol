import { randomUUID } from 'node:crypto';
import type { Actor, Scope, NormalizedEvent, Observation, ExternalLink, DecisionRunRecord, InboxEntry, InboxStatus, AuditSink, Provider, Route } from '../core/contracts.ts';
import { assertPermission, domainOf, priorityOf, safeErrorCode, errorKind } from '../core/contracts.ts';
import { resolveDevice } from '../graph/resolver.ts';
import type { DecisionProvider, DecisionConfig } from '../decisions/provider.ts';
import { defaultDecisionConfig } from '../decisions/provider.ts';
import { MemoryAudit } from '../audit/memory.ts';
import { eventKey, conflictEventKey, payloadHash } from './identity.ts';
import { callProvider, draftDecision, finalRoute } from './decision.ts';
import type { RunDraft } from './decision.ts';

export interface IngestResult {
  eventKey: string; conflictOfEventKey: string | null; status: InboxStatus; attempts: number; observation: Observation | null; safeErrorCode: string | null;
}
export interface PipelineOptions {
  config?: DecisionConfig;
  /** Attempts after which a TRANSIENT failure becomes a visible dead letter. */
  maxAttempts?: number;
  /**
   * Stand-in for the final observation/audit transaction of the DB version. Errors thrown here are classified by kind.
   * Tests use it to exercise RETRY and DEAD_LETTER; production code replaces the whole pipeline with the durable worker.
   */
  commitHook?: (observation: Observation) => Promise<void>;
}
/** Result of phase 1 (resolve + decide). Persisted once per event and reused on every retry of phase 2. */
interface PreparedDecision {
  entityId: string | null; route: Route; confidence: number; provider: Provider; promptVersion: string; reasonCodes: string[];
  appliedRunId: string;
}
interface StoredEvent { event: NormalizedEvent; payloadHash: string; conflictOfEventKey: string | null }

/**
 * In-memory reference of the durable pipeline described in docs/03. Maps stand in for PostgreSQL tables; they are not shared
 * across processes and do not survive restart. The control flow is the contract:
 *   store (durable inbox) → phase 1 once per event: resolve device, obtain the decision, persist DecisionRuns as NOT applied →
 *   phase 2, retried as a whole: observation + audit + inbox completion + the applied flag succeed or fail together.
 * A retry of phase 2 never calls the provider again and never creates a second applied run. In shadow mode the rules
 * baseline is committed without waiting for the AI; the AI result lands later as a non-applied run and never changes the
 * observation. A redelivery with the same identity but different content is stored as separate evidence linked to the
 * canonical event and routed to urgent human review; the canonical evidence is never overwritten.
 */
export class ReferencePipeline {
  #inbox = new Map<string, InboxEntry>();
  #events = new Map<string, StoredEvent>();
  #observations = new Map<string, Observation>();
  #decisionRuns = new Map<string, DecisionRunRecord>();
  #decisions = new Map<string, PreparedDecision>();
  #pending = new Map<string, Promise<IngestResult>>();
  #shadow = new Set<Promise<void>>();
  #provider: DecisionProvider;
  #links: ExternalLink[];
  #config: DecisionConfig;
  #maxAttempts: number;
  #commitHook: ((observation: Observation) => Promise<void>) | null;
  readonly audit: AuditSink;

  constructor(provider: DecisionProvider, links: ExternalLink[], audit: AuditSink = new MemoryAudit(), options: PipelineOptions = {}) {
    this.#provider = provider; this.#links = structuredClone(links); this.audit = audit;
    this.#config = options.config ?? defaultDecisionConfig;
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#commitHook = options.commitHook ?? null;
  }

  async ingest(actor: Actor, event: NormalizedEvent, correlationId: string): Promise<IngestResult> {
    assertPermission(actor, event, 'events:ingest');
    const canonicalKey = eventKey(event);
    const hash = payloadHash(event);
    // Content is compared BEFORE joining an in-flight delivery, so a concurrent redelivery with different content is
    // never mistaken for a duplicate of the canonical event.
    const stored = this.#events.get(canonicalKey);
    const conflict = stored !== undefined && stored.payloadHash !== hash;
    const key = conflict ? conflictEventKey(canonicalKey, hash) : canonicalKey;
    const inflight = this.#pending.get(key);
    if (inflight) return structuredClone(await inflight);
    const work = this.#ingest(actor, structuredClone(event), correlationId, key, hash, conflict ? canonicalKey : null);
    this.#pending.set(key, work);
    try { return structuredClone(await work); } finally { this.#pending.delete(key); }
  }

  async #ingest(actor: Actor, event: NormalizedEvent, correlationId: string, key: string, hash: string, conflictOfEventKey: string | null): Promise<IngestResult> {
    const now = new Date().toISOString();
    const scope: Scope = { workspaceId: event.workspaceId, clientId: event.clientId };
    let entry = this.#inbox.get(key);
    if (!entry) {
      // Durable write stand-in. From here on the event cannot be lost; every outcome is a status with a reason.
      this.#events.set(key, { event, payloadHash: hash, conflictOfEventKey });
      entry = { workspaceId: event.workspaceId, clientId: event.clientId, eventKey: key, conflictOfEventKey, status: 'RECEIVED', attempts: 0, lastErrorCode: null, receivedAt: now, updatedAt: now };
      this.#inbox.set(key, entry);
      if (conflictOfEventKey) {
        this.audit.append(scope, actor.id, 'event.revision_conflict', correlationId, { eventKey: key, conflictOfEventKey, safeErrorCode: 'REVISION_PAYLOAD_CONFLICT' });
      }
    }
    if (entry.status === 'PROCESSED') return this.#result(entry, this.#observations.get(key) ?? null);
    if (entry.status === 'DEAD_LETTER') return this.#result(entry, null);
    entry.attempts += 1; entry.updatedAt = now;
    try {
      const observation = await this.#process(actor, key, correlationId);
      this.#observations.set(key, observation);
      entry.status = 'PROCESSED'; entry.lastErrorCode = null;
      return this.#result(entry, observation);
    } catch (error) {
      const code = safeErrorCode(error);
      entry.lastErrorCode = code;
      if (errorKind(error) === 'TRANSIENT' && entry.attempts < this.#maxAttempts) {
        entry.status = 'RETRY';
        this.audit.append(scope, actor.id, 'event.retry_scheduled', correlationId, { eventKey: key, safeErrorCode: code, attempts: String(entry.attempts), inboxStatus: 'RETRY' });
      } else {
        entry.status = 'DEAD_LETTER';
        this.audit.append(scope, actor.id, 'event.dead_lettered', correlationId, { eventKey: key, safeErrorCode: code, attempts: String(entry.attempts), inboxStatus: 'DEAD_LETTER' });
      }
      return this.#result(entry, null);
    }
  }

  #result(entry: InboxEntry, observation: Observation | null): IngestResult {
    return { eventKey: entry.eventKey, conflictOfEventKey: entry.conflictOfEventKey, status: entry.status, attempts: entry.attempts, observation, safeErrorCode: entry.lastErrorCode };
  }

  async #process(actor: Actor, key: string, correlationId: string): Promise<Observation> {
    const stored = this.#events.get(key)!;
    const event = stored.event;
    // Phase 1 — once per event. On a retry the stored decision is reused; the provider is not called again.
    let prepared = this.#decisions.get(key);
    if (!prepared) { prepared = await this.#prepare(event, key, stored.conflictOfEventKey); this.#decisions.set(key, prepared); }
    // Phase 2 — final transaction stand-in. Order matters: the commit hook (durable write) and the audit append are the
    // steps that can fail; nothing is published (applied flag, observation, inbox completion) until both have succeeded.
    // The durable worker puts all four changes into one database transaction.
    const observation: Observation = { workspaceId: event.workspaceId, clientId: event.clientId, id: randomUUID(), eventKey: key, event,
      entityId: prepared.entityId, domain: domainOf(event.kind), severity: event.sourceSeverity, priority: priorityOf(event.sourceSeverity),
      route: prepared.route, confidence: prepared.confidence, provider: prepared.provider, promptVersion: prepared.promptVersion,
      reasonCodes: [...prepared.reasonCodes], decisionRunId: prepared.appliedRunId, conflictOfEventKey: stored.conflictOfEventKey,
      status: 'OPEN', createdAt: new Date().toISOString() };
    if (this.#commitHook) await this.#commitHook(structuredClone(observation));
    this.audit.append({ workspaceId: event.workspaceId, clientId: event.clientId }, actor.id, 'observation.created', correlationId, {
      observationId: observation.id, eventKey: key, route: observation.route, priority: observation.priority, provider: observation.provider,
      reasonCodes: observation.reasonCodes.join(','), decisionRunId: prepared.appliedRunId,
      ...(stored.conflictOfEventKey ? { conflictOfEventKey: stored.conflictOfEventKey } : {}) });
    // Publish: from here on nothing can fail (in-memory assignments only). The caller marks the inbox entry PROCESSED.
    this.#decisionRuns.get(prepared.appliedRunId)!.applied = true;
    return observation;
  }

  async #prepare(event: NormalizedEvent, key: string, conflictOfEventKey: string | null): Promise<PreparedDecision> {
    // 1. Graph resolution. A conflicting confirmed mapping is evidence for a human, not a reason to drop the event.
    let entityId: string | null = null; let linkConflictCode: string | null = null;
    try { entityId = resolveDevice(event, this.#links); }
    catch (error) { if (errorKind(error) === 'CONFLICT') linkConflictCode = safeErrorCode(error); else throw error; }

    // 2. Decision (decision.ts). Runs are recorded as NOT applied; the applied flag is set in phase 2 with the observation.
    const draft = await draftDecision(this.#provider, this.#config, event);
    const runs = draft.runs.map(run => this.#recordRun(event, key, run));
    if (draft.shadowPending) this.#launchShadow(event, key);
    // 3. Deterministic rules after the model (decision.ts): each appends its reason, none overwrites another.
    const { route, reasonCodes } = finalRoute({ classification: draft.classification, entityId, linkConflictCode, conflictOfEventKey,
      sourceSeverity: event.sourceSeverity, confidenceThreshold: this.#config.confidenceThreshold });
    return { entityId, route, confidence: draft.classification.confidence, provider: draft.classification.provider,
      promptVersion: draft.classification.promptVersion, reasonCodes, appliedRunId: runs[draft.appliedRun]!.id };
  }

  #launchShadow(event: NormalizedEvent, key: string): void {
    const task = callProvider(this.#provider, event).then(call => {
      this.#recordRun(event, key, { provider: this.#provider.provider, mode: this.#provider.mode, result: call.result, error: call.error,
        latencyMs: call.latencyMs, details: call.details });
    });
    this.#shadow.add(task);
    void task.finally(() => this.#shadow.delete(task));
  }

  #recordRun(event: NormalizedEvent, key: string, draft: RunDraft): DecisionRunRecord {
    const { provider, mode, result, error, latencyMs, details } = draft;
    const run: DecisionRunRecord = { workspaceId: event.workspaceId, clientId: event.clientId, id: randomUUID(), eventKey: key,
      provider, mode, applied: false, status: result ? 'OK' : 'FAILED',
      route: result?.route ?? null, confidence: result?.confidence ?? null, promptVersion: result?.promptVersion ?? this.#config.promptVersion,
      requestedModel: result?.requestedModel ?? details.requestedModel ?? null, responseModel: result?.responseModel ?? details.responseModel ?? null,
      safeErrorCode: error, latencyMs, createdAt: new Date().toISOString() };
    this.#decisionRuns.set(run.id, run);
    return run;
  }

  /** Waits for in-flight shadow evaluations. Tests and graceful shutdown use it; the observation never depends on it. */
  async drainShadow(): Promise<void> { await Promise.all([...this.#shadow]); }

  list(scope: Scope): Observation[] {
    return structuredClone([...this.#observations.values()].filter(o => o.workspaceId === scope.workspaceId && o.clientId === scope.clientId));
  }
  inbox(scope: Scope): InboxEntry[] {
    return structuredClone([...this.#inbox.values()].filter(e => e.workspaceId === scope.workspaceId && e.clientId === scope.clientId));
  }
  deadLetters(scope: Scope): InboxEntry[] { return this.inbox(scope).filter(e => e.status === 'DEAD_LETTER'); }
  decisionRuns(scope: Scope): DecisionRunRecord[] {
    return structuredClone([...this.#decisionRuns.values()].filter(r => r.workspaceId === scope.workspaceId && r.clientId === scope.clientId));
  }
}
