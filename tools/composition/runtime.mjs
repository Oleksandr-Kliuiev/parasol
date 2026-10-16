import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const secret = () => randomBytes(24).toString('hex');
export const sqlPassword = () => `Aa1!${secret()}`;
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function safeEnvironment(extra = {}) {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'DOTNET_ROOT', 'CI', 'PLAYWRIGHT_BROWSERS_PATH'];
  return { ...Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', ...extra };
}
export async function createStateDirectory(path) {
  if (!path.startsWith('/') || resolve(path) !== path) throw new Error('State directory must be a normalized absolute path.');
  let current = dirname(path);
  while (current !== dirname(current)) {
    const info = await lstat(current).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) throw new Error('State directory must not have symlinked parents.');
    current = dirname(current);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(path, { mode: 0o700 }); // EEXIST is deliberate: never reuse somebody else's run.
  if (await realpath(path) !== path) throw new Error('State path changed while creating the run.');
  await mkdir(join(path, 'private'), { mode: 0o700 });
  await mkdir(join(path, 'logs'), { mode: 0o700 });
}
export async function jsonFile(path, value, mode = 0o600) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode });
}
export async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(error => error ? reject(error) : resolve(port)); });
  });
}
export function redact(value, secrets = []) {
  let text = String(value);
  for (const item of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(item).join('[redacted]');
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[database-url]')
    .replace(/(Password|ClientKey|ApplicationKey|SubscriptionKey|Bearer)[=: ]+[^;\s"']+/gi, '$1=[redacted]');
}
export async function command(binary, args, { cwd, env = safeEnvironment(), input, label = 'command', logPath, secrets = [], timeout = 300_000, signal } = {}) {
  signal?.throwIfAborted();
  const child = spawn(binary, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const terminate = () => {
    if (!child.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let output = ''; const collect = bytes => { output = (output + bytes.toString()).slice(-1_000_000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  // Early CLI exit may close its pipe before a large input has finished writing.
  child.stdin.on('error', () => {});
  const timer = setTimeout(terminate, timeout); signal?.addEventListener('abort', terminate, { once: true });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  child.stdin.end(input);
  let result;
  try { result = await exit; }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', terminate); terminate();
    if (logPath) await writeFile(logPath, redact(output, secrets), { mode: 0o600 });
  }
  signal?.throwIfAborted();
  if (result.code !== 0) throw new Error(`${label} failed (${result.signal ?? result.code}); inspect its redacted stage log.`);
  return output;
}
export function startProcess(binary, args, { cwd, env = safeEnvironment(), label, bindingLine }) {
  const child = spawn(binary, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  // Drain app output. Product logs can contain connection errors: public reports retain only process health and exit status.
  let bindingConfirmed = bindingLine === undefined; let fragment = '';
  child.stdout.on('data', bytes => {
    if (bindingConfirmed) return;
    fragment += bytes.toString(); const lines = fragment.split(/\r?\n/); fragment = lines.pop().slice(-1024);
    if (lines.some(line => line === bindingLine)) bindingConfirmed = true;
  }); child.stderr.on('data', () => {});
  let finished = false; let stopping = false; let startupError;
  child.once('error', error => { startupError = error; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { finished = true; resolve({ code, signal }); }));
  return { label, pid: child.pid, get finished() { return finished; }, get stopping() { return stopping; },
    get bindingConfirmed() { return bindingConfirmed; }, get startupError() { return startupError; },
    async stop() {
      stopping = true;
      if (finished || !child.pid) return;
      const signal = name => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
      signal('SIGTERM');
      if (await Promise.race([exited.then(() => true), pause(15_000).then(() => false)])) return;
      signal('SIGKILL'); await Promise.race([exited, pause(5000)]);
      if (!finished) throw new Error(`Owned ${label} process did not exit.`);
    }, exited };
}
export async function waitReady(url, handle, expected = 200, timeout = 120_000, requestOptions = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (handle?.finished || handle?.startupError) throw new Error(`${handle.label} exited before readiness.`);
    try { if (handle?.bindingConfirmed !== false && (await localRequest(url, requestOptions)).status === expected) return; } catch { /* bounded readiness probe */ }
    await pause(250);
  }
  throw new Error('Owned application readiness timed out.');
}
export function localRequest(url, { method = 'GET', headers = {}, data, ca } = {}) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Fixture HTTP must stay on loopback.');
  return new Promise((resolve, reject) => {
    const request = (parsed.protocol === 'https:' ? httpsRequest : httpRequest)(parsed,
      { method, headers, rejectUnauthorized: true, ca, timeout: 5000 }, response => {
        const chunks = []; let length = 0;
        response.on('data', chunk => { length += chunk.length; if (length > 4 * 1024 * 1024) request.destroy(new Error('Fixture response too large.')); else chunks.push(chunk); });
        response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
    request.once('error', reject); request.once('timeout', () => request.destroy(new Error('Fixture HTTP timed out.')));
    request.end(data);
  });
}
export async function stateFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))
    throw new Error('Private fixture state must be an owned regular 0600 file.');
  if (await realpath(path) !== resolve(path)) throw new Error('Private fixture state must not have symlinked parents.');
  return JSON.parse(await readFile(path, 'utf8'));
}
