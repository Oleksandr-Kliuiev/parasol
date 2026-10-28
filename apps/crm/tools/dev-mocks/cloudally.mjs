// CloudAlly stand-in for external-apis.mjs (M42), following CloudAlly's partner API v2 as its reference describes it
// (api.cloudally.com/documentation, groups "Authentication v2" and "Management v2"); synthetic data only. Under /cloudally:
//   POST /v2/auth/partner  (client-id, client-secret headers; {email, password})  → {accessToken, expiresIn, refreshToken, …}
//   POST /v2/auth/refresh  (the same headers; {refreshToken})
//   GET  /v2/resellers/details, /v2/resellers/accounts, /v2/resellers/accounts/backup-tasks, /v2/resellers/accounts/backup-statuses,
//        /v2/resellers/accounts/{account}/backup-tasks/{task} (with its entities), /v2/resellers/bills — pages of `pageSize` from page 1,
//        the statuses also with a page token
//   POST …/backup-tasks/{task}/backupNow | pause | activate, …/entities/{entity}/backupNow | activate,
//        /v2/resellers/accounts/{account}/recovery/restore | export; DELETE /v2/resellers/accounts/{account}
//   POST /v2/resellers/accounts (M43: a new trial account, client-id and client-secret headers required)
// Data calls without the bearer token answer 403 with an empty body, as CloudAlly does. Test-only control routes live under
// /_mock/cloudally (see the README).

const SERVICES = ['MS365', 'ONEDRIVE', 'SHAREPOINT_MULTI', 'MS365GROUPS'];

export function createCloudAlly({ base, run, send }) {
  const token = `mock-cloudally-${run}`;
  const refreshToken = `${token}-refresh`;
  let nextId = base * 10;
  const id = (prefix) => `${prefix}-${(nextId++).toString(36)}`;
  const accounts = new Map();
  const tasks = new Map();
  const log = [];

  const compact = (date) => date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000);

  /** One entity's backup as a state says: ok, failed, late, paused or notactive (known to CloudAlly, not backed up). */
  function entityTimes(entity, state) {
    entity.state = state;
    entity.status = state === 'notactive' ? 'NOTACTIVE' : state === 'paused' ? 'PAUSED' : 'ACTIVE';
    entity.error = state === 'failed' ? (entity.errorText ?? 'Mailbox is full') : null;
    const success = { ok: hoursAgo(3), failed: hoursAgo(30), late: hoursAgo(40), paused: hoursAgo(60) }[state] ?? null;
    const attempt = state === 'failed' ? hoursAgo(2) : success;
    entity.lastBackupDate = success ? compact(success) : null;
    entity.lastBackupAttemptDate = attempt ? compact(attempt) : null;
  }

  function addTask(account, source, entities, paused) {
    const task = {
      id: id('task'), account: account.name, type: 'BACKUP', source, userId: account.id, status: paused ? 'PAUSED' : 'ACTIVE',
      region: account.region, alias: { MS365: 'Exchange', ONEDRIVE: 'OneDrive', SHAREPOINT_MULTI: 'SharePoint', MS365GROUPS: 'Teams & Groups' }[source],
      nextBackup: '0 2 * * *', size: 0, createDate: hoursAgo(24 * 90).toISOString(), userEmail: account.email, multiEntitiesTask: true, entities: [],
    };
    for (const spec of entities) {
      const entity = { id: id('ent'), userId: account.id, taskId: task.id, entity: spec.name, fullName: spec.fullName ?? null, extId: id('ext'), errorText: spec.error };
      entityTimes(entity, spec.state ?? 'ok');
      task.entities.push(entity);
    }
    tasks.set(task.id, task);
    account.tasks.push(task.id);
    return task;
  }

  /** An account with Exchange, OneDrive, SharePoint and Teams tasks; `users` carry each mailbox's state, OneDrive is backed up. */
  function addAccount(spec) {
    const account = {
      id: spec.id ?? crypto.randomUUID(), name: spec.name ?? `Kunde ${nextId}`, email: spec.email ?? `admin@${(spec.domain ?? 'kunde.example')}`,
      status: spec.status ?? 'ACTIVE', region: spec.region ?? 'EU', partnerID: 'PID-MOCK', currency: 'EUR', externalId: spec.externalId ?? null,
      restoreNeedsSignIn: Boolean(spec.restoreNeedsSignIn), tasks: [],
    };
    accounts.set(account.id, account);
    const users = spec.users ?? [];
    const paused = new Set(spec.pausedServices ?? []);
    for (const source of spec.services ?? SERVICES) {
      const entities = source === 'MS365' ? users.map((u) => ({ name: u.email, fullName: u.fullName, state: u.state, error: u.error }))
        : source === 'ONEDRIVE' ? users.filter((u) => u.state !== 'notactive').map((u) => ({ name: u.email, fullName: u.fullName, state: u.onedrive ?? 'ok' }))
          : source === 'SHAREPOINT_MULTI' ? (spec.sites ?? [{ name: 'Prosjekter' }]).map((s) => ({ name: s.name, state: s.state }))
            : (spec.teams ?? [{ name: 'Alle ansatte' }]).map((t) => ({ name: t.name, state: t.state }));
      addTask(account, source, entities, paused.has(source));
    }
    return account;
  }

  addAccount({ name: 'Fjord IT AS', domain: 'fjordit.example', users: [
    { email: 'kari@fjordit.example', fullName: 'Kari Nordmann' }, { email: 'ola@fjordit.example', fullName: 'Ola Nordmann', state: 'failed' },
    { email: 'nyansatt@fjordit.example', fullName: 'Nina Nyansatt', state: 'notactive' }] });
  addAccount({ name: 'Havbris Test AS', domain: 'havbris.example', pausedServices: ['SHAREPOINT_MULTI'], users: [{ email: 'post@havbris.example', fullName: 'Post Havbris' }] });

  const publicTask = ({ entities, ...task }, withEntities) => {
    const all = entities.filter((e) => e.status !== 'NOTACTIVE');
    const dates = all.map((e) => e.lastBackupDate).filter(Boolean).sort();
    const view = { ...task, lastBackupDates: dates.length ? { mail: Number(dates.at(-1)) } : {}, numOfEntities: entities.length, numOfBilledEntities: all.length };
    if (withEntities) {
      view.entities = entities.map((e) => ({ id: e.id, userId: e.userId, taskId: e.taskId, entity: e.entity, fullName: e.fullName, extId: e.extId,
        status: e.status, lastBackupDates: e.lastBackupDate ? { mail: Number(e.lastBackupDate) } : {} }));
    }
    return view;
  };
  const publicAccount = ({ tasks: _tasks, restoreNeedsSignIn: _signIn, ...account }) => account;
  const listed = () => [...accounts.values()].filter((a) => a.status !== 'DELETED');

  function page(url, items, tokens) {
    const size = Math.max(1, Number(url.searchParams.get('pageSize') ?? 20));
    const number = tokens && url.searchParams.get('nextPageToken')?.startsWith('p') ? Number(url.searchParams.get('nextPageToken').slice(1)) : Number(url.searchParams.get('page') ?? 1);
    const totalPages = Math.max(1, Math.ceil(items.length / size));
    return { page: number, totalPages, total: items.length, nextPageToken: tokens && number < totalPages ? `p${number + 1}` : null, data: items.slice((number - 1) * size, number * size) };
  }

  // Every entity of a task, the ones not in backup too: the live account lists them with Microsoft's licence and no backup yet.
  const statuses = () => [...tasks.values()].filter((t) => accounts.get(t.userId)?.status !== 'DELETED').flatMap((t) => t.entities
    .map((e) => ({ userId: t.userId, taskId: t.id, source: t.source, entityName: e.entity, lastBackupDate: e.lastBackupDate, lastBackupAttemptDate: e.lastBackupAttemptDate,
      backupDuration: 60_000, size: 1_048_576, msLicensing: t.source === 'MS365' ? 'LICENSED' : 'NA',
      backupStatus: e.status === 'NOTACTIVE' ? []
        : [{ subSource: 'mail', status: e.error ? 'FAILED' : 'SUCCESS', error: e.error, errFAQLink: e.error ? 'https://support.cloudally.example.invalid/hc/mailbox-full' : null }] })));

  const bills = () => listed().map((a) => {
    const lines = a.tasks.map((tid) => tasks.get(tid)).map((t) => ({ price: 2.5, accounts: t.entities.filter((e) => e.status !== 'NOTACTIVE').length,
      seat: t.entities.filter((e) => e.status !== 'NOTACTIVE').length, service: t.alias, type: 'BACKUP', source: t.source, storage: 1_048_576, total: 2.5 * t.entities.length }));
    return { userId: a.id, email: a.email, discount: 0, currency: 'EUR', paymentType: 'MONTHLY', nextPaymentDate: new Date(Date.UTC(2026, 10, 1)).toISOString(),
      subscribed: true, total: lines.reduce((sum, l) => sum + l.total, 0), trialDaysLeft: 0, lines, payments: [] };
  });

  const ok = (res, status = 'OK') => send(res, 200, { success: true, status, statusCode: 200 });

  function control(req, res, path, body) {
    if (req.method === 'POST' && path === 'accounts') {
      const account = addAccount(body);
      return send(res, 201, { ...publicAccount(account), tasks: account.tasks.map((tid) => publicTask(tasks.get(tid), true)) });
    }
    const account = path.match(/^accounts\/([^/]+)$/);
    if (req.method === 'GET' && account && accounts.has(account[1])) {
      const found = accounts.get(account[1]);
      return send(res, 200, { ...publicAccount(found), tasks: found.tasks.map((tid) => publicTask(tasks.get(tid), true)) });
    }
    const entity = path.match(/^entities\/([^/]+)$/);
    if (req.method === 'POST' && entity) {
      const found = [...tasks.values()].flatMap((t) => t.entities).find((e) => e.id === entity[1]);
      if (!found) return send(res, 404, { message: 'Unknown entity' });
      if (body.error) found.errorText = body.error;
      entityTimes(found, body.state ?? 'ok');
      return send(res, 200, found);
    }
    if (req.method === 'GET' && path === 'log') return send(res, 200, log);
    return send(res, 404, { message: 'Unknown control route' });
  }

  /** Answers a CloudAlly request (true) or leaves it to the caller (false). */
  return function handle(req, res, url, body) {
    let json = {};
    try { json = body ? JSON.parse(body) : {}; } catch { json = null; }
    if (url.pathname.startsWith('/_mock/cloudally/')) {
      control(req, res, url.pathname.slice('/_mock/cloudally/'.length), json ?? {});
      return true;
    }
    if (!url.pathname.startsWith('/cloudally/')) return false;
    const path = url.pathname.slice('/cloudally/'.length);

    if (req.method === 'POST' && (path === 'v2/auth/partner' || path === 'v2/auth/refresh')) {
      const application = req.headers['client-id'] && req.headers['client-secret'];
      const valid = path === 'v2/auth/partner' ? json?.email && json?.password : json?.refreshToken === refreshToken;
      if (!application || !valid) send(res, 401, { errorMessage: 'Invalid client credentials' });
      else send(res, 200, { accessToken: token, tokenType: 'Bearer', expiresIn: 3600, refreshToken, refreshTokenExpiresIn: 86_400 });
      return true;
    }
    if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
      res.writeHead(403);
      res.end();
      return true;
    }

    if (req.method === 'GET' && path === 'v2/resellers/details') {
      send(res, 200, { partnerId: 'PID-MOCK', email: 'partner@parasoll.example', contactName: 'Parasoll', currency: 'EUR', region: 'EU' });
    } else if (req.method === 'GET' && path === 'v2/resellers/accounts') {
      send(res, 200, page(url, listed().map(publicAccount), false));
    } else if (req.method === 'POST' && path === 'v2/resellers/accounts') {
      // M43 (addAccount): a trial account without backup tasks — those need the customer's Microsoft 365 consent in CloudAlly. The
      // application headers are required here; one account per address. The log keeps that a password came, never the password.
      const regions = ['US_EST', 'US_EST_OHIO', 'US_WEST_OREGON', 'US_WEST_CAL', 'EU', 'EU_FRANKFURT', 'ASIA_HONG_KONG', 'ASIA_MUMBAI', 'ASIA_SEOUL',
        'ASIA_SINGAPORE', 'ASIA_SIDNEY', 'ASIA_TOKYO', 'SOUTH_AMERICA', 'AFRICA_CAPE_TOWN', 'ASIA_CHINA', 'CANADA', 'LONDON', 'EU_PARIS', 'EU_STOCKHOLM', 'EU_ZURICH'];
      const email = typeof json?.email === 'string' ? json.email.trim() : '';
      log.push({ method: req.method, path, body: { ...json, password: json?.password ? '[given]' : null }, at: new Date().toISOString() });
      if (!req.headers['client-id'] || !req.headers['client-secret']) send(res, 401, { errorMessage: 'Invalid client credentials' });
      else if (!email || typeof json?.password !== 'string' || json.password.length < 1 || (json.region && !regions.includes(json.region))) {
        send(res, 400, { status: 400, error: 'email, password and a known region are required' });
      } else if (listed().some((a) => a.email.toLowerCase() === email.toLowerCase())) send(res, 400, { status: 400, error: 'The email is already in use' });
      else {
        const created = { id: crypto.randomUUID(), name: json.displayName?.trim() || email, email, status: 'TRIAL', region: json.region ?? 'US_EST', partnerID: 'PID-MOCK',
          currency: 'EUR', externalId: null, restoreNeedsSignIn: false, tasks: [] };
        accounts.set(created.id, created);
        send(res, 200, publicAccount(created));
      }
    } else if (req.method === 'GET' && path === 'v2/resellers/accounts/backup-tasks') {
      send(res, 200, page(url, listed().flatMap((a) => a.tasks.map((tid) => publicTask(tasks.get(tid), false))), false));
    } else if (req.method === 'GET' && path === 'v2/resellers/accounts/backup-statuses') {
      send(res, 200, page(url, statuses(), true));
    } else if (req.method === 'GET' && path === 'v2/resellers/bills') {
      send(res, 200, page(url, bills(), false));
    } else {
      const route = path.match(/^v2\/resellers\/accounts\/([^/]+)(?:\/(backup-tasks|recovery)\/([^/]+)(?:\/entities\/([^/]+))?(?:\/([A-Za-z]+))?)?$/);
      const account = route && accounts.get(route[1]);
      const task = route?.[2] === 'backup-tasks' ? tasks.get(route[3]) : null;
      if (!account || account.status === 'DELETED' || (route[2] === 'backup-tasks' && task?.userId !== account.id)) {
        send(res, 404, { status: 404, error: 'Not Found', path: url.pathname });
        return true;
      }
      if (req.method !== 'GET') log.push({ method: req.method, path, body: json, at: new Date().toISOString() });
      const entity = route[4] ? task.entities.find((e) => e.id === route[4]) : null;
      if (route[4] && !entity) send(res, 404, { status: 404, error: 'Not Found', path: url.pathname });
      else if (req.method === 'GET' && task && !route[4] && !route[5]) send(res, 200, publicTask(task, true));
      else if (req.method === 'DELETE' && !route[2]) { account.status = 'DELETED'; ok(res, 'Account deleted'); }
      else if (req.method === 'POST' && route[5] === 'backupNow') { (entity ? [entity] : task.entities.filter((e) => e.status === 'ACTIVE')).forEach((e) => entityTimes(e, 'ok')); ok(res); }
      else if (req.method === 'POST' && route[5] === 'pause' && !entity) { task.status = 'PAUSED'; ok(res); }
      else if (req.method === 'POST' && route[5] === 'activate') {
        if (entity) { entity.status = 'ACTIVE'; entity.state = 'waiting'; } else task.status = 'ACTIVE';
        ok(res);
      } else if (req.method === 'POST' && route[2] === 'recovery' && (route[3] === 'restore' || route[3] === 'export')) {
        if (!json?.taskId || !json?.account || !json?.source || !json?.date) send(res, 400, { status: 400, error: 'taskId, account, source and date are required' });
        else if (route[3] === 'export') send(res, 200, {});
        else send(res, 200, account.restoreNeedsSignIn ? { needRedirect: true, redirectUrl: 'https://login.example.invalid/consent', showNotification: false }
          : { needRedirect: false, showNotification: true, notificationMessage: 'The restore has started' });
      } else send(res, 404, { status: 404, error: 'Not Found', path: url.pathname });
    }
    return true;
  };
}
