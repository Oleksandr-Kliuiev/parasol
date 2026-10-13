// Exact local console origin (docs/stage5/03_SECURITY_AND_STATE.md). DOM-free: callers pass location fields.
// Token entry exists only on plain HTTP 127.0.0.1 with an explicit port, at /operator/. No alias, remote host or proxy.
const ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/;

export function isConsoleLocation(origin: string, pathname: string): boolean {
  const match = ORIGIN.exec(origin);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1024 && port <= 65535 && pathname === '/operator/';
}
