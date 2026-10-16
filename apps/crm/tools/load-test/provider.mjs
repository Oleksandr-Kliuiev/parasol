// Explicitly simulated PowerOffice boundary for DEV-16. Binds loopback only.
// Delays/quotas are test assumptions, never evidence of a real provider's limits.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function createProvider({ latencyMs = 150, jitterMs = 100, requestsPerSecond = 10, failureEvery = 0 } = {}) {
  for (const value of [latencyMs, jitterMs, requestsPerSecond, failureEvery]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Simulation parameters must be non-negative integers');
  }
  if (!requestsPerSecond) throw new Error('requestsPerSecond must be positive');
  const orders = new Map();
  const stats = { requests: 0, throttled: 0, injectedFailures: 0, created: 0, duplicateReferences: 0 };
  let windowStart = Date.now();
  let inWindow = 0;
  const send = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return send(res, 200, { mode: 'simulated' });
    if (url.pathname === '/stats') return send(res, 200, { mode: 'simulated', profile: { latencyMs, jitterMs, requestsPerSecond, failureEvery }, ...stats, orders: orders.size });
    const sequence = ++stats.requests;
    await new Promise((resolve) => setTimeout(resolve, latencyMs + sequence % (jitterMs + 1)));
    if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); inWindow = 0; }
    if (++inWindow > requestsPerSecond) {
      stats.throttled++; res.setHeader('retry-after', '1');
      return send(res, 429, { simulated: true, error: 'SIMULATED_QUOTA' });
    }
    if (failureEvery && sequence % failureEvery === 0) {
      stats.injectedFailures++;
      return send(res, 503, { simulated: true, error: 'SIMULATED_UNAVAILABLE_BEFORE_EFFECT' });
    }
    if (url.pathname === '/OAuth/Token') return send(res, 200, { access_token: 'synthetic-local-token', token_type: 'bearer', expires_in: 1200 });
    if (url.pathname === '/v2/SalesOrders' && req.method === 'GET') {
      const reference = url.searchParams.get('externalImportReferences');
      return send(res, 200, reference ? [...orders.values()].filter((order) => order.ExternalImportReference === reference) : [...orders.values()]);
    }
    if (url.pathname === '/v2/SalesOrders' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1000000) return send(res, 413, {}); }
      let posted;
      try { posted = JSON.parse(body); } catch { return send(res, 400, {}); }
      const reference = posted.ExternalImportReference;
      if (!reference || !Array.isArray(posted.Lines) || !posted.CustomerId) return send(res, 400, { error: 'INVALID_ORDER' });
      if (orders.has(reference)) {
        stats.duplicateReferences++;
        // A duplicate send is surfaced, not silently made idempotent by the simulator.
        return send(res, 409, { error: 'DUPLICATE_REFERENCE' });
      }
      const id = ++stats.created;
      const order = { Id: id, OrderNo: 16000 + id, CustomerId: posted.CustomerId, ExternalImportReference: reference,
        CustomerReference: posted.CustomerReference, OrderDate: posted.OrderDate, Status: 'Draft',
        TotalAmount: posted.Lines.reduce((sum, line) => sum + line.Quantity * line.UnitPrice * (1 - (line.DiscountPercent ?? 0) / 100), 0) };
      orders.set(reference, order);
      return send(res, 201, order);
    }
    if (['/v2/Customers', '/v2/ContactPersons', '/v2/Products', '/v2/OutgoingInvoices'].includes(url.pathname) && req.method === 'GET') return send(res, 200, []);
    return send(res, 404, { error: 'UNSUPPORTED_SIMULATION_ROUTE' });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 5300);
  const server = createProvider({ failureEvery: Number(process.env.SIMULATED_FAILURE_EVERY ?? 0) });
  server.listen(port, '127.0.0.1', () => console.log(`Simulated provider on 127.0.0.1:${port}; 150–250ms, 10 requests/s.`));
}
