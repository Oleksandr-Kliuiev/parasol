// CloudAlly stand-in for external-apis.mjs (M40.S): a stub until M42 brings the integration. Under /cloudally it answers the
// partner sign-in (`POST /auth/partner` with client id and secret, `POST /auth/refresh`) with a synthetic bearer token, and the
// partner's backup tasks (`GET /v1/partners/tasks`, operation listPartnerTasks) with synthetic Microsoft 365 backups: one
// succeeded, one failed, one paused. Public sources name these paths but not their fields; M42 confirms the fields and paging
// against CloudAlly's own reference (api.cloudally.com/documentation) before any code reads them.

export function createCloudAlly({ base, run, send }) {
  const token = `mock-cloudally-${run}`;
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const tasks = [
    { id: `t-${base + 21}`, customerName: 'Fjord IT AS', source: 'MS365', type: 'Exchange', status: 'ACTIVE', lastBackupStatus: 'SUCCESS', lastBackupDate: hoursAgo(6) },
    { id: `t-${base + 22}`, customerName: 'Fjord IT AS', source: 'MS365', type: 'OneDrive', status: 'ACTIVE', lastBackupStatus: 'FAILED', lastBackupDate: hoursAgo(30) },
    { id: `t-${base + 23}`, customerName: 'Havbris Test AS', source: 'MS365', type: 'SharePoint', status: 'PAUSED', lastBackupStatus: 'SUCCESS', lastBackupDate: hoursAgo(80) },
  ];

  /** Answers a CloudAlly request (true) or leaves it to the caller (false). */
  return function handle(req, res, url, body) {
    if (!url.pathname.startsWith('/cloudally/')) return false;
    const path = url.pathname.slice('/cloudally'.length);
    if (req.method === 'POST' && (path === '/auth/partner' || path === '/auth/refresh')) {
      let request = {};
      try { request = body ? JSON.parse(body) : {}; } catch { request = null; }
      if (request === null || (path === '/auth/partner' && !(request.clientId && request.clientSecret))) {
        send(res, 400, { message: 'clientId and clientSecret are required' });
      } else {
        send(res, 200, { accessToken: token, refreshToken: `${token}-refresh`, expiresIn: 3600 });
      }
      return true;
    }
    if ((req.headers.authorization ?? '') !== `Bearer ${token}`) send(res, 401, { message: 'Unauthorized' });
    else if (req.method === 'GET' && path === '/v1/partners/tasks') send(res, 200, { data: tasks, total: tasks.length });
    else send(res, 404, { message: 'Not found' });
    return true;
  };
}
