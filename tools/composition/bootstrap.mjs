import { localRequest } from './runtime.mjs';
import { ROLES, visibleClients, WORKSPACE } from './plan.mjs';

export class FixtureSession {
  constructor(baseUrl, ca) { this.baseUrl = baseUrl; this.ca = ca; this.cookies = new Map(); }
  async request(path, body) {
    const result = await localRequest(new URL(path, this.baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      ca: this.ca,
      headers: { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF': '1' }) },
      data: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of result.headers['set-cookie'] ?? []) {
      const pair = cookie.split(';')[0]; const at = pair.indexOf('='); this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return result;
  }
  async json(path, body, expected = 200) {
    const response = await this.request(path, body);
    if (response.status !== expected) throw new Error(`Real CRM bootstrap endpoint failed with HTTP ${response.status}.`);
    try { return JSON.parse(response.body); } catch { throw new Error('Real CRM bootstrap endpoint returned invalid JSON.'); }
  }
  async signIn(role) {
    const response = await this.request(`/bff/dev-login?role=${encodeURIComponent(role)}&returnUrl=%2F`);
    if (response.status !== 302) throw new Error('Real Development BFF sign-in failed.');
    return this.json('/bff/user');
  }
}

export async function bootstrapCrm(state) {
  const employees = [];
  for (const role of ROLES) {
    const session = new FixtureSession(state.baseUrl, state.certificatePublic); const user = await session.signIn(role);
    if (typeof user.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(user.id)) throw new Error('A real CRM employee identity was not provisioned.');
    employees.push({ id: user.id, role, displayName: user.displayName ?? `Synthetic ${role.slice(4)}`,
      visibleClientIds: visibleClients(role, state.plan.clients), token: state.employeeTokens[role] });
    if (role === ROLES[0]) state.adminSession = session;
  }
  if (new Set(employees.map(e => e.id)).size !== 3) throw new Error('Composition requires three distinct real CRM identities.');
  state.employees = employees;
  for (const client of state.plan.clients) {
    const organization = await state.adminSession.json('/api/v1/customers/organizations', { name: client.name, status: 'Customer' }, 201);
    if (!organization.id) throw new Error('A synthetic CRM customer was not created.');
    client.crmCustomerId = organization.id;
  }
}

export async function linkCustomers(state) {
  const session = new FixtureSession(state.baseUrl, state.certificatePublic); const user = await session.signIn(ROLES[0]);
  if (user.id !== state.employees[0].id) throw new Error('The real employee changed across the private configuration restart.');
  const directory = await session.json('/api/v1/parasol/customer-identities/atlas-export');
  const snapshot = directory.snapshot;
  if (directory.status !== 'READY' || snapshot?.schemaVersion !== 1 || snapshot.source !== 'atlas' || snapshot.workspaceId !== WORKSPACE || snapshot.clients?.length !== 40
    || !state.plan.clients.every(client => snapshot.clients.some(row => row.clientId === client.atlasClientId && row.name === client.name)))
    throw new Error('The actual personal Atlas directory did not match the explicit synthetic customer plan.');
  const input = { snapshot,
  mappings: state.plan.clients.map(c => ({ atlasClientId: c.atlasClientId, customerId: c.crmCustomerId })) };
  const endpoint = '/api/v1/parasol/customer-identities/import';
  const preview = await session.json(endpoint, input);
  if (!preview.canApply || !/^[a-f0-9]{64}$/.test(preview.sha256)) throw new Error('Explicit synthetic customer mapping preview failed.');
  const applied = await session.json(`${endpoint}?dryRun=false&expectedSha256=${preview.sha256}`, input);
  if (applied.dryRun || applied.rows.length !== 40) throw new Error('Explicit synthetic customer mapping application failed.');
}
