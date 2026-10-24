// OpenAPI 3.1 description of the DB-mode Atlas API (served at GET /openapi.json by deploy/proxy-identity.ts). Shapes are described
// at the level a client needs; the authoritative contracts are packages/core/contracts.ts and the per-route validators.
const bearer = [{ bearer: [] }];
const json = (description: string, schema: object = { type: 'object' }) => ({ description, content: { 'application/json': { schema } } });
const errors = {
  401: { description: 'Missing, malformed, unknown, revoked or expired bearer token (no detail)' },
  403: { description: 'Outside the actor\'s scope or permission (audited; the same answer for forbidden, unknown and malformed IDs)' },
};
const clientId = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,62}$' } };
const intQuery = (name: string, description: string) => ({ name, in: 'query', required: false, description, schema: { type: 'integer', minimum: 1 } });
const strQuery = (name: string, description: string, required = false) => ({ name, in: 'query', required, description, schema: { type: 'string' } });

export const OPENAPI_DOCUMENT = Object.freeze({
  openapi: '3.1.0',
  info: {
    title: 'Vardahei Atlas API', version: '1.0.0-pilot',
    description: 'Read-only MSP context API. Every call is made as an Atlas actor: a machine client sends its own bearer token; a person signs in '
      + 'with a Microsoft work account at the edge. Permissions are per client (context:read, events:ingest, mapping:review, connections:manage, '
      + 'm365:read). Responses never include credentials; vendor secrets are referenced, not stored.',
  },
  servers: [{ url: 'https://admin.vardahei.tech', description: 'Public edge (Microsoft sign-in for people; bearer token for machines)' },
    { url: 'http://atlas-admin-api:3100', description: 'Internal Docker network on the VPS (bearer token)' }],
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'Atlas API token of an actor (atl_…)' } } },
  security: bearer,
  paths: {
    '/clients': { get: { summary: 'Clients the actor is a member of', responses: { 200: json('Client list', { type: 'array', items: { type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } } } }), 401: errors[401] } } },
    '/clients/identity-export': { get: { summary: 'Parasol v1 identity snapshot of authorized clients only (context:read)',
      responses: { 200: json('Atlas identity export: schemaVersion, source, workspaceId, clients'), ...errors } } },
    '/clients/{id}/overview': { get: { summary: 'ClientContextV1: resources with statuses, entities, open observations (context:read)',
      parameters: [clientId], responses: { 200: json('ClientContextV1'), ...errors } } },
    '/clients/{id}/observations': { get: { summary: 'Observation page, newest first (context:read)', parameters: [clientId,
      intQuery('limit', 'Page size (bounded by the server)'), strQuery('status', 'Filter: OPEN, ACKNOWLEDGED, RESOLVED, SUPPRESSED'),
      strQuery('severity', 'Filter: INFO, LOW, MEDIUM, HIGH, CRITICAL'), strQuery('cursor', 'Opaque keyset cursor from the previous page')],
      responses: { 200: json('Observation page with nextCursor'), 400: { description: 'Invalid filter or cursor' }, ...errors } } },
    '/clients/{id}/observations/{observationId}': { get: { summary: 'Exact stored ObservationSummary in any lifecycle state (context:read; no-store)',
      parameters: [clientId, { name: 'observationId', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,100}$' } }],
      responses: { 200: json('ObservationSummary'), 400: { description: 'Invalid observation identifier' },
        404: { description: 'Observation not found within the authorized client' }, ...errors } } },
    '/clients/{id}/audit': { get: { summary: 'Client audit trail (context:read)', parameters: [clientId, intQuery('limit', 'Page size')],
      responses: { 200: json('Audit events (allowlisted fields only)'), ...errors } } },
    '/clients/{clientId}/observations/{observationId}/correlation': { get: { summary: 'CorrelationContextV1: M365 directory and sign-in context of one observation (context:read + m365:read)',
      parameters: [{ ...clientId, name: 'clientId' }, { name: 'observationId', in: 'path', required: true, schema: { type: 'string' } },
        strQuery('connectionId', 'The Microsoft 365 connection', true), strQuery('from', 'ISO-8601 UTC start (inclusive)', true),
        strQuery('to', 'ISO-8601 UTC end (exclusive)', true), intQuery('limit', 'Page size'), strQuery('cursor', 'Authenticated cursor')],
      responses: { 200: json('CorrelationContextV1'), 400: { description: 'Invalid interval, limit or cursor' }, ...errors } } },
    '/clients/{clientId}/poweroffice/{connectionId}/status': { get: { summary: 'PowerOffice connection status (MOCK only in this pilot)',
      parameters: [{ ...clientId, name: 'clientId' }, { name: 'connectionId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: json('Status'), 404: { description: 'Unknown or invisible connection' }, 503: { description: 'PowerOffice disabled' }, ...errors } } },
    '/tools': { get: { summary: 'Read tools the actor may call, with parameter schemas', responses: { 200: json('Tool descriptions', { type: 'array' }), 401: errors[401] } } },
    '/tools/execute': { post: { summary: 'Execute one read tool (ToolRequest version "1"); every call is recorded in the ToolExecution ledger',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['version', 'requestId', 'clientId', 'tool', 'parameters'],
        properties: { version: { const: '1' }, requestId: { type: 'string', format: 'uuid' }, clientId: { type: 'string' }, tool: { type: 'string' },
          parameters: { type: 'object' } } } } } },
      responses: { 200: json('Tool result; X-Atlas-Correlation-Id and X-Atlas-Tool-Execution-Id headers'), 201: json('Stored evidence read'),
        400: { description: 'Malformed request or parameters' }, ...errors } } },
    '/audit/security': { get: { summary: 'Workspace security (denial) log (workspace permission security_audit:read)',
      parameters: [intQuery('limit', 'Page size')], responses: { 200: json('Security audit events'), ...errors } } },
    '/session': { get: { summary: 'Who is signed in at the edge (Microsoft sign-in only)', security: [],
      responses: { 200: json('Signed-in user', { type: 'object', properties: { user: { type: 'string', format: 'email' } } }), 401: { description: 'Not signed in through the edge' } } } },
    '/openapi.json': { get: { summary: 'This document', security: [], responses: { 200: json('OpenAPI 3.1 document') } } },
  },
});
