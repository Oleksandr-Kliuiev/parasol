// Vendors' webhooks for external-apis.mjs (M44): what Huntress (through Svix) and an Atera ticket automation rule send to Parasoll. A test
// or a demo asks `POST /_mock/webhooks/huntress` with the event's body ({ event_type, id, ... }) or `POST /_mock/webhooks/atera` with the
// rule's body ({ TicketID }). The stand-in signs the Huntress delivery the way Svix does — HMAC-SHA256 over "{id}.{timestamp}.{body}" with
// the key of the endpoint's whsec_ secret, sent as "v1,{Base64}" in svix-signature — or puts the key in Atera's address, sends it to the
// CRM and answers with the CRM's status ({ status }). The CRM's address, the secret and the key come from the environment
// (WEBHOOK_TARGET, HUNTRESS_WEBHOOK_SECRET, ATERA_WEBHOOK_KEY), with the e2e suite's synthetic values by default. Nothing is sent to any
// other address, and only a loopback address may use an untrusted certificate (the development one of the e2e suite).
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

/** The e2e suite's synthetic secret and key (playwright.config.ts gives crm-web the same). Never a vendor's. */
export const E2E_HUNTRESS_SECRET = 'whsec_c3ludGhldGljLWUyZS1odW50cmVzcy1zZWNyZXQ=';
export const E2E_ATERA_KEY = 'synthetic-e2e-atera-webhook-key-0123456789';

const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The signature header Svix sends for a body: one "v1," entry. */
export function svixSignature(secret, id, timestamp, body) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  return `v1,${crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export function createWebhooks({ send }) {
  const target = new URL(process.env.WEBHOOK_TARGET ?? 'https://localhost:5181');
  const secret = process.env.HUNTRESS_WEBHOOK_SECRET ?? E2E_HUNTRESS_SECRET;
  const key = process.env.ATERA_WEBHOOK_KEY ?? E2E_ATERA_KEY;
  const sent = [];

  /** Posts the delivery to the CRM and settles with its status, or 0 when the CRM could not be reached. */
  function deliver(path, headers, body) {
    const url = new URL(path, target);
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      const request = client.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
        rejectUnauthorized: !loopback.has(url.hostname),
        timeout: 15_000,
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('timeout', () => request.destroy());
      request.on('error', () => resolve(0));
      request.end(body);
    });
  }

  async function huntress(res, body) {
    const id = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const status = await deliver('/webhooks/huntress', {
      'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': svixSignature(secret, id, timestamp, body),
    }, body);
    sent.push({ system: 'huntress', at: new Date().toISOString(), status });
    send(res, 200, { status });
  }

  async function atera(res, body) {
    const status = await deliver(`/webhooks/atera/${encodeURIComponent(key)}`, {}, body);
    sent.push({ system: 'atera', at: new Date().toISOString(), status });
    send(res, 200, { status });
  }

  /** Answers a webhook control request (true) or leaves it to the caller (false). */
  return function handle(req, res, url, body) {
    if (!url.pathname.startsWith('/_mock/webhooks/')) return false;
    const path = url.pathname.slice('/_mock/webhooks/'.length).replace(/\/$/, '');
    if (req.method === 'GET' && path === 'sent') send(res, 200, sent);
    else if (req.method === 'POST' && path === 'huntress') void huntress(res, body || '{}');
    else if (req.method === 'POST' && path === 'atera') void atera(res, body || '{}');
    else send(res, 404, { error: 'Unknown webhook control route' });
    return true;
  };
}
