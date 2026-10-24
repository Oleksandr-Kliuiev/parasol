import { createServer, request } from 'node:http';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

/** Transparent recorder: every response is produced by the actual confined Atlas API. Never records credentials/query/body. */
export async function recordingGateway(state) {
  const path = join(state.directory, 'private/atlas-access.json');
  const stats = { requests: 0, providerWrites: 0, byEmployee: {} }; let pending = Promise.resolve();
  const persist = () => { pending = pending.then(async () => {
    await writeFile(`${path}.tmp`, JSON.stringify(stats), { mode: 0o600 }); await rename(`${path}.tmp`, path);
  }); return pending; };
  await persist();
  const server = createServer((incoming, outgoing) => {
    stats.requests++;
    if (!['GET', 'HEAD'].includes(incoming.method ?? '')) stats.providerWrites++;
    const employee = state.employees?.find(e => incoming.headers.authorization === `Bearer ${e.token}`);
    if (employee) stats.byEmployee[employee.role] = (stats.byEmployee[employee.role] ?? 0) + 1;
    void persist().catch(() => outgoing.destroy());
    const headers = { ...incoming.headers, host: `127.0.0.1:${state.ports.atlas}` };
    const upstream = request({ hostname: '127.0.0.1', port: state.ports.atlas, path: incoming.url,
      method: incoming.method, headers, timeout: 10_000 }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    upstream.on('timeout', () => upstream.destroy()); incoming.on('aborted', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(state.ports.gateway, '127.0.0.1', resolve); });
  return { statsPath: path, async close() {
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await pending;
  } };
}
