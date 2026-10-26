// Huntress stand-in for external-apis.mjs (M40.S): a stub until M41 brings the integration. It answers the reads M41 starts
// from — the account, the organizations and their agents — with synthetic data under /huntress/v1, behind HTTP Basic auth
// (API key and secret, as Huntress's API asks). What public sources agree on: base https://api.huntress.io/v1, Basic auth,
// list endpoints with `limit` (at most 500). They disagree on paging (`page` or `page_token`), so the stub honours both and
// answers both in `pagination`; M41 confirms the paths, paging and agent fields (Defender status, last contact) against
// Huntress's own reference before any code reads them.

const pageOf = (items, url) => {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25), 1), 500);
  const page = Math.max(Number(url.searchParams.get('page') ?? url.searchParams.get('page_token') ?? 1), 1);
  const slice = items.slice((page - 1) * limit, page * limit);
  const more = page * limit < items.length;
  return {
    slice,
    pagination: {
      current_page: page, current_page_count: slice.length, limit, total_count: items.length,
      next_page: more ? page + 1 : null, next_page_token: more ? String(page + 1) : null,
    },
  };
};

export function createHuntress({ base, run, send }) {
  const account = { id: base, name: `Vardahei stand-in ${run}`, subdomain: 'vardahei-mock' };
  const organizations = [
    { id: base + 1, name: 'Fjord IT AS', key: 'fjord-it', agents_count: 2, created_at: '2026-01-05T08:00:00Z' },
    { id: base + 2, name: 'Havbris Test AS', key: 'havbris-test', agents_count: 1, created_at: '2026-02-11T08:00:00Z' },
  ];
  const agent = (id, organizationId, hostname, platform, os, extra = {}) => ({
    id, organization_id: organizationId, account_id: base, hostname, platform, os, version: '0.13.140',
    mac_addresses: [], serial_number: null, ipv4_address: '10.0.0.10', external_ip: '198.51.100.10',
    last_callback_at: new Date().toISOString(), created_at: '2026-03-01T08:00:00Z', updated_at: new Date().toISOString(), ...extra,
  });
  const agents = [
    agent(base + 11, base + 1, 'SRV-01', 'windows', 'Windows Server 2022', { serial_number: 'VMW-4C4C4544-0042' }),
    agent(base + 12, base + 1, 'PC-17', 'windows', 'Windows 11 Pro'),
    agent(base + 13, base + 2, 'MAC-03', 'darwin', 'macOS 15'),
  ];

  /** Answers a Huntress request (true) or leaves it to the caller (false). */
  return function handle(req, res, url) {
    if (!url.pathname.startsWith('/huntress/v1/')) return false;
    if (!/^Basic\s+\S+/.test(req.headers.authorization ?? '')) {
      send(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const path = url.pathname.slice('/huntress/v1'.length);
    if (req.method !== 'GET') send(res, 405, { error: 'This stand-in only reads.' });
    else if (path === '/account') send(res, 200, { account });
    else if (path === '/organizations') {
      const { slice, pagination } = pageOf(organizations, url);
      send(res, 200, { organizations: slice, pagination });
    } else if (path === '/agents') {
      const organization = url.searchParams.get('organization_id');
      const { slice, pagination } = pageOf(organization ? agents.filter((a) => String(a.organization_id) === organization) : agents, url);
      send(res, 200, { agents: slice, pagination });
    } else {
      const one = path.match(/^\/agents\/(\d+)$/);
      const found = one && agents.find((a) => String(a.id) === one[1]);
      if (found) send(res, 200, { agent: found });
      else send(res, 404, { error: 'Not found' });
    }
    return true;
  };
}
