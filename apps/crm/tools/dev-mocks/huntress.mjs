// Huntress API v1 stand-in for external-apis.mjs (M41): the routes Crm.Integrations.Huntress calls, as Huntress's own reference
// (OpenAPI at api.huntress.io/v1/swagger_doc.json) describes them — account, organizations with their actual usage, agents with
// isolation and uninstall, incident reports with remediations and comments, escalations, platform actions and summary reports —
// under /huntress/v1 behind HTTP Basic auth, with `limit` (≤ 500) and an opaque `page_token`. Test-only control routes under
// /_mock/huntress add organizations, agents, incidents, escalations and platform actions, change them, read back what the CRM sent
// and make the next requests fail (README). Seed data in huntress-data.mjs; everything in memory and new on every start.

import { agentDefaults, remediation, seedHuntress } from './huntress-data.mjs';

const ISOLATED = ['Isolated', 'Pending Isolation'];
const REJECTION_REASONS = [
  'unspecified', 'approved_application', 'manually_remediated', 'host_reimaged', 'testing_security_controls', 'other',
  'approved_user_login_location_m365', 'approved_user_email_forwarding_rule_m365', 'approved_application_m365', 'manually_remediated_m365',
  'testing_security_controls_m365', 'approved_vpn_or_proxy_usage_m365', 'other_m365',
];
const API_USER = { id: 9001, name: 'Dev API User', email: 'api-user@vardahei-mock.example.invalid' };
const DAY = 86_400_000;

const versionCompare = (a, b) => {
  const x = String(a ?? '').split('.').map(Number);
  const y = String(b ?? '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
};

export function createHuntress({ base, run, send }) {
  const { account, organizations, agents, incidents, escalations, platformActions, reports } = seedHuntress({ base, run });
  let nextId = base + 10_000;
  const newId = () => nextId++;
  // Change times only ever grow, so a reader's cursor at one change never hides another made in the same millisecond.
  let lastStamp = 0;
  const stamp = () => new Date((lastStamp = Math.max(Date.now(), lastStamp + 1))).toISOString();
  const fail = (res, status, message) => send(res, status, { errors: [message] });
  const parse = (body) => {
    try {
      const value = body ? JSON.parse(body) : {};
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };

  // What the CRM sent, per record (`incident:<id>`, `escalation:<id>`, `agent:<id>`), for a test to read back.
  const posted = new Map();
  const remember = (key, what, value) => posted.set(key, { ...posted.get(key), [what]: value });

  // Faults a test asked for: the next `count` requests with this method and path answer `status` (and change nothing).
  const faults = [];
  const fault = (method, path) => {
    const index = faults.findIndex((f) => f.method === method && (f.path === path || (f.path.endsWith('*') && path.startsWith(f.path.slice(0, -1)))));
    if (index < 0) return null;
    const found = faults[index];
    if (--found.count <= 0) faults.splice(index, 1);
    return found.status;
  };

  // An isolation or a release is confirmed by the host at its next callback: the next read of the agent shows the result.
  const pending = new Map();
  const settle = (agent) => {
    if (pending.has(agent.id)) {
      agent.firewall_status = pending.get(agent.id);
      agent.updated_at = stamp();
      pending.delete(agent.id);
    }
    return agent;
  };

  const organizationOf = (id) => organizations.find((o) => o.id === Number(id));
  const agentOf = (id) => agents.find((a) => a.id === Number(id));
  const incidentOf = (id) => incidents.find((i) => i.id === Number(id));
  const noticesOf = (kind) => (kind === 'escalation' ? escalations : platformActions);

  // Lists: sorted by `sort_field` (id, desc by default), `limit` 1–500 (10 by default), the offset carried by an opaque token.
  const page = (req, res, url, plural, items) => {
    const asked = Number(url.searchParams.get('limit') ?? 10);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 500) : 10;
    const token = url.searchParams.get('page_token');
    const offset = token ? Number(Buffer.from(token, 'base64url').toString('utf8').replace(/^offset:/, '')) : 0;
    if (!Number.isInteger(offset) || offset < 0) return fail(res, 400, 'Invalid page_token');
    const field = url.searchParams.get('sort_field') ?? 'id';
    const direction = url.searchParams.get('sort_direction') === 'asc' ? 1 : -1;
    const sorted = [...items].sort((a, b) => {
      const x = a[field] ?? null;
      const y = b[field] ?? null;
      if (x === y) return direction * (a.id - b.id);
      if (x === null) return 1;
      if (y === null) return -1;
      return direction * (x < y ? -1 : 1);
    });
    const slice = sorted.slice(offset, offset + limit);
    const pagination = {};
    if (offset + limit < sorted.length) {
      pagination.next_page_token = Buffer.from(`offset:${offset + limit}`).toString('base64url');
      const next = new URL(`http://${req.headers.host ?? 'localhost'}${url.pathname}${url.search}`);
      next.searchParams.set('page_token', pagination.next_page_token);
      next.searchParams.set('limit', String(limit));
      pagination.next_page_url = next.toString();
    }
    return send(res, 200, { [plural]: slice, pagination });
  };

  // The account's newest agent version per platform, from the agents it has now.
  const newest = (platform) => agents.filter((a) => a.platform === platform).map((a) => a.version).sort(versionCompare).at(-1);
  const organizationView = (o) => ({
    ...o,
    agents_count: agents.filter((a) => a.organization_id === o.id).length,
    incident_reports_count: incidents.filter((i) => i.organization_id === o.id).length,
  });
  const usageOf = (o) => {
    const fleet = agents.filter((a) => a.organization_id === o.id);
    return {
      edr: {
        billable_agents_count: fleet.length,
        unresponsive_agents_count: fleet.filter((a) => Date.now() - Date.parse(a.last_callback_at) > 7 * DAY).length,
        outdated_agents_count: fleet.filter((a) => versionCompare(a.version, newest(a.platform)) < 0).length,
        isolated_agents_count: fleet.filter((a) => a.firewall_status === 'Isolated').length,
      },
      itdr: o.identity_provider_tenant_id
        ? [{ type: 'microsoft', identity_provider_tenant_id: o.identity_provider_tenant_id, billable_identities_count: o.billable_identity_count,
          total_identities_count: o.billable_identity_count + 5 }]
        : [],
      sat: { learners_count: o.sat_learner_count },
    };
  };
  const incidentView = (incident, all = false) => {
    const { plan, comments, ...report } = incident;
    return { ...report, remediations: { total_count: plan.length, has_more: !all && plan.length > 10, items: all ? plan : plan.slice(0, 10) } };
  };
  const noticeView = (notice, withEntities) => {
    const { entities, ...rest } = notice;
    return withEntities ? { ...rest, entities: { total_count: entities.length, has_more: false, items: entities } } : rest;
  };
  const touch = (record) => { record.updated_at = stamp(); };

  // The API's routes: method, path below /huntress/v1/, answer.
  const routes = [
    ['GET', /^account$/, (req, res) => send(res, 200, { account })],
    ['GET', /^organizations$/, (req, res, url) => {
      const name = url.searchParams.get('name');
      const key = url.searchParams.get('key');
      return page(req, res, url, 'organizations',
        organizations.filter((o) => (!name || o.name === name) && (!key || o.key === key)).map(organizationView));
    }],
    ['GET', /^organizations\/(\d+)$/, (req, res, url, body, [id]) => {
      const o = organizationOf(id);
      return o ? send(res, 200, { organization: { ...organizationView(o), actual_usages: usageOf(o) } }) : fail(res, 404, 'Organization not found');
    }],
    ['GET', /^agents$/, (req, res, url) => {
      const p = url.searchParams;
      return page(req, res, url, 'agents', agents.filter((a) =>
        (!p.get('organization_id') || a.organization_id === Number(p.get('organization_id'))) && (!p.get('platform') || a.platform === p.get('platform'))
        && (!p.get('hostname') || a.hostname === p.get('hostname')) && (!p.get('os') || a.os === p.get('os'))
        && (!p.get('version') || a.version === p.get('version'))).map(settle));
    }],
    ['GET', /^agents\/(\d+)$/, (req, res, url, body, [id]) => {
      const agent = agentOf(id);
      return agent ? send(res, 200, { agent: settle(agent) }) : fail(res, 404, 'Agent not found.');
    }],
    ['DELETE', /^agents\/(\d+)$/, (req, res, url, body, [id]) => {
      const index = agents.findIndex((a) => a.id === Number(id));
      if (index < 0) return fail(res, 404, 'Agent not found.');
      // Uninstall is scheduled for the host's next callback; the agent leaves the account at once.
      remember(`agent:${id}`, 'uninstalled', true);
      agents.splice(index, 1);
      return send(res, 204);
    }],
    ['POST', /^agents\/(\d+)\/isolation$/, (req, res, url, body, [id]) => {
      const agent = agentOf(id);
      if (!agent) return fail(res, 404, 'Agent not found.');
      const asked = parse(body);
      if (!asked) return fail(res, 400, 'The body must be a JSON object');
      if (ISOLATED.includes(agent.firewall_status)) return fail(res, 409, 'Agent does not support host isolation, or isolation could not be scheduled.');
      remember(`agent:${id}`, 'isolation', asked);
      agent.firewall_status = 'Pending Isolation';
      pending.set(agent.id, 'Isolated');
      touch(agent);
      return send(res, 201, { agent });
    }],
    ['DELETE', /^agents\/(\d+)\/isolation$/, (req, res, url, body, [id]) => {
      const agent = agentOf(id);
      if (!agent) return fail(res, 404, 'Agent not found.');
      if (!ISOLATED.includes(agent.firewall_status)) return fail(res, 409, 'Agent does not support host isolation, or release could not be scheduled.');
      remember(`agent:${id}`, 'release', true);
      agent.firewall_status = 'Pending Release';
      pending.set(agent.id, 'Disabled');
      touch(agent);
      // The reference answers this one with the agent itself, not wrapped.
      return send(res, 200, agent);
    }],
    ['GET', /^incident_reports$/, (req, res, url) => {
      const p = url.searchParams;
      // A draft (back at the SOC) is shown only to a read by id.
      return page(req, res, url, 'incident_reports', incidents.filter((i) => i.status !== 'draft'
        && (!p.get('status') || i.status === p.get('status')) && (!p.get('severity') || i.severity === p.get('severity'))
        && (!p.get('platform') || i.platform === p.get('platform')) && (!p.get('organization_id') || i.organization_id === Number(p.get('organization_id')))
        && (!p.get('agent_id') || i.agent_id === Number(p.get('agent_id'))) && (!p.get('indicator_type') || i.indicator_types.includes(p.get('indicator_type'))))
        .map((i) => incidentView(i)));
    }],
    ['GET', /^incident_reports\/(\d+)$/, (req, res, url, body, [id]) => {
      const incident = incidentOf(id);
      return incident ? send(res, 200, { incident_report: incidentView(incident) }) : fail(res, 404, 'Incident Report not found');
    }],
    ['POST', /^incident_reports\/(\d+)\/resolution$/, (req, res, url, body, [id]) => {
      const incident = incidentOf(id);
      if (!incident) return fail(res, 404, 'Incident Report not found');
      if (incident.status !== 'sent' || incident.plan.some((r) => r.status === 'unapproved')) {
        return fail(res, 409, "Incident Report cannot be resolved. Confirm that all remediations are approved and report status is 'sent'.");
      }
      remember(`incident:${id}`, 'resolution', parse(body) ?? {});
      const now = stamp();
      Object.assign(incident, { status: 'closed', closed_at: now, status_updated_at: now, updated_at: now });
      return send(res, 201, { incident_report: incidentView(incident) });
    }],
    ['GET', /^incident_reports\/(\d+)\/comments$/, (req, res, url, body, [id]) => {
      const incident = incidentOf(id);
      return incident ? page(req, res, url, 'comments', incident.comments) : fail(res, 404, 'Incident Report not found');
    }],
    ['POST', /^incident_reports\/(\d+)\/comments$/, (req, res, url, body, [id]) => {
      const incident = incidentOf(id);
      if (!incident) return fail(res, 404, 'Incident Report not found');
      const text = parse(body)?.body;
      if (typeof text !== 'string' || !text.trim() || text.length > 2048) return fail(res, 422, 'Unable to create comment.');
      const now = stamp();
      const comment = { id: newId(), body: text, author: API_USER.name, created_at: now, updated_at: now };
      incident.comments.push(comment);
      remember(`incident:${id}`, 'comment', { body: text });
      incident.updated_at = now;
      return send(res, 201, { comment });
    }],
    ['GET', /^incident_reports\/(\d+)\/remediations$/, (req, res, url, body, [id]) => {
      const incident = incidentOf(id);
      if (!incident) return fail(res, 404, 'Incident Report not found');
      const list = (name) => (url.searchParams.get(`${name}[]`) ?? url.searchParams.get(name))?.split(',').filter(Boolean);
      const types = list('types');
      const statuses = list('statuses');
      return page(req, res, url, 'remediations', incident.plan.filter((r) => (!types || types.includes(r.type)) && (!statuses || statuses.includes(r.status))));
    }],
    ['GET', /^incident_reports\/(\d+)\/remediations\/(\d+)$/, (req, res, url, body, [id, rid]) => {
      const step = incidentOf(id)?.plan.find((r) => r.id === Number(rid));
      return step ? send(res, 200, { remediation: step }) : fail(res, 404, 'Remediation not found');
    }],
    ['POST', /^incident_reports\/(\d+)\/remediations\/(\d+)\/completion$/, (req, res, url, body, [id, rid]) => {
      const incident = incidentOf(id);
      const step = incident?.plan.find((r) => r.id === Number(rid));
      if (!step) return fail(res, 404, 'Remediation not found');
      if (step.type !== 'manual') return fail(res, 409, 'This remediation cannot be manually completed. Huntress completes this type of remediation automatically.');
      const completed = parse(body)?.completed;
      if (typeof completed !== 'boolean') return fail(res, 422, 'Unable to update remediation.');
      remember(`incident:${id}`, 'completion', { remediation_id: step.id, completed });
      // Marking a step done does not approve it; undoing it leaves it as approved (or not) as it was.
      Object.assign(step, completed
        ? { status: 'completed', completed_at: stamp() }
        : { status: step.approved_at ? 'approved' : 'unapproved', completed_at: null });
      touch(incident);
      return send(res, 201, { remediation: step });
    }],
    ['POST', /^incident_reports\/(\d+)\/remediations\/bulk_approval$/, (req, res, url, body, [id]) => {
      const incident = incidentOf(id);
      if (!incident) return fail(res, 404, 'Incident Report not found');
      const asked = parse(body);
      if (!asked) return fail(res, 422, 'Unable to approve remediations');
      if (incident.status !== 'sent') return fail(res, 409, "Incident Report must have a status of 'sent'.");
      remember(`incident:${id}`, 'approval', asked);
      const now = stamp();
      for (const step of incident.plan.filter((r) => r.status === 'unapproved')) {
        Object.assign(step, { status: 'approved', approved_at: now, approved_by: API_USER });
      }
      incident.updated_at = now;
      return send(res, 201, { incident_report: incidentView(incident) });
    }],
    ['POST', /^incident_reports\/(\d+)\/remediations\/bulk_rejection$/, (req, res, url, body, [id]) => {
      const incident = incidentOf(id);
      if (!incident) return fail(res, 404, 'Incident Report not found');
      const asked = parse(body);
      if (!asked || typeof asked.comment !== 'string' || !asked.comment.trim() || asked.comment.length > 2048 || typeof asked.useful !== 'boolean'
        || (asked.reason !== undefined && !REJECTION_REASONS.includes(asked.reason))) {
        return fail(res, 422, 'Unable to reject remediations');
      }
      if (incident.status !== 'sent') return fail(res, 409, "Incident Report must have a status of 'sent'.");
      remember(`incident:${id}`, 'rejection', asked);
      // The plan goes back to the SOC: the report is a draft again, and its steps that were waiting are void.
      const now = stamp();
      for (const step of incident.plan.filter((r) => r.status === 'unapproved')) step.status = 'cancelled';
      Object.assign(incident, { status: 'draft', status_updated_at: now, updated_at: now });
      return send(res, 201);
    }],
    ...['escalation', 'platform_action'].flatMap((kind) => {
      const plural = `${kind}s`;
      const notices = noticesOf(kind);
      return [
        ['GET', new RegExp(`^${plural}$`), (req, res, url) => {
          const p = url.searchParams;
          return page(req, res, url, plural, notices.filter((n) => (!p.get('status') || n.status === p.get('status'))
            && (!p.get('severity') || n.severity === p.get('severity')) && (!p.get('subtype') || n.subtype === p.get('subtype'))
            && (!p.get('organization_id') || n.organizations.some((o) => o.id === Number(p.get('organization_id')))))
            .map((n) => noticeView(n, false)));
        }],
        ['GET', new RegExp(`^${plural}/(\\d+)$`), (req, res, url, body, [id]) => {
          const notice = notices.find((n) => n.id === Number(id));
          return notice ? send(res, 200, { [kind]: noticeView(notice, true) }) : fail(res, 404, 'Not found');
        }],
      ];
    }),
    ['POST', /^escalations\/(\d+)\/resolution$/, (req, res, url, body, [id]) => {
      const escalation = escalations.find((n) => n.id === Number(id));
      if (!escalation) return fail(res, 404, 'Not found');
      const asked = parse(body);
      // As Huntress's reference says: the revoke flag can only be included beside the determination "unauthorized".
      if (!asked || (asked.determination !== undefined && !['expected', 'unauthorized'].includes(asked.determination))
        || (asked.scope !== undefined && !['account', 'organization', 'identity'].includes(asked.scope))
        || (asked.revoke_and_disable_identities !== undefined && asked.determination !== 'unauthorized')) {
        return fail(res, 400, 'Invalid resolution parameters');
      }
      if (escalation.status === 'resolved') return fail(res, 409, 'Escalation has already been resolved');
      remember(`escalation:${id}`, 'resolution', asked);
      const now = stamp();
      Object.assign(escalation, { status: 'resolved', resolved_at: now, updated_at: now });
      const access = /country_access|vpn_access/.test(escalation.type_code ?? '');
      return send(res, 201, {
        escalation: noticeView(escalation, true),
        resolution_method: asked.determination ? 'rule' : access ? 'dismiss' : 'direct',
      });
    }],
    ['GET', /^reports$/, (req, res, url) => {
      const p = url.searchParams;
      const start = (r) => r.period.slice(0, 10);
      return page(req, res, url, 'reports', reports.filter((r) => (!p.get('type') || r.type === p.get('type'))
        && (!p.get('organization_id') || r.organization_id === Number(p.get('organization_id')))
        && (!p.get('period_min') || start(r) >= p.get('period_min').slice(0, 10)) && (!p.get('period_max') || start(r) <= p.get('period_max').slice(0, 10)))
        .map((r) => reportView(req, r)));
    }],
    ['GET', /^reports\/(\d+)$/, (req, res, url, body, [id]) => {
      const report = reports.find((r) => r.id === Number(id));
      return report ? send(res, 200, { report: reportView(req, report) }) : fail(res, 404, 'Report not found');
    }],
  ];

  // M43: a report's link leads to the stand-in's own "web site", which redirects to its "file storage", as Huntress's
  // huntress.io link redirects to a signed blob; neither needs the API key. A report created with a `url` keeps it.
  const reportView = (req, report) => (report.url ? report : { ...report, url: `http://${req.headers.host ?? 'localhost'}/huntress-files/reports/${report.id}.pdf` });

  /** A small but whole PDF of one page naming the report, so a browser opens it and the CRM's envelope check passes. */
  function reportPdf(id) {
    const text = `Huntress monthly summary ${id} (stand-in, synthetic)`;
    const stream = `BT /F1 14 Tf 72 760 Td (${text}) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = objects.map((object, index) => {
      const at = pdf.length;
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      return at;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
  }

  function files(req, res, url) {
    const failed = fault(req.method, url.pathname);
    if (failed) return fail(res, failed, 'Synthetic failure');
    const link = /^\/huntress-files\/reports\/(\d+)\.pdf$/.exec(url.pathname);
    if (link && req.method === 'GET') {
      if (!reports.some((r) => r.id === Number(link[1]))) return fail(res, 404, 'Report not found');
      res.writeHead(302, { Location: `/huntress-blobs/${link[1]}.pdf?disposition=download` });
      return res.end();
    }
    const blob = /^\/huntress-blobs\/(\d+)\.pdf$/.exec(url.pathname);
    if (blob && req.method === 'GET') {
      const content = reportPdf(blob[1]);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': content.length });
      return res.end(content);
    }
    return fail(res, 404, 'Unknown Huntress file');
  }

  function api(req, res, url, body) {
    // HTTP Basic: Base64 of "<api key>:<api secret>", as Huntress asks on every request.
    const basic = /^Basic\s+(\S+)$/.exec(req.headers.authorization ?? '');
    const pair = basic ? Buffer.from(basic[1], 'base64').toString('utf8') : '';
    if (!/^[^:]+:.+$/.test(pair)) return fail(res, 401, 'Unauthorized');
    const failed = fault(req.method, url.pathname);
    if (failed) return fail(res, failed, 'Synthetic failure');
    const path = url.pathname.slice('/huntress/v1/'.length).replace(/\/$/, '');
    const matching = routes.filter(([, pattern]) => pattern.test(path));
    const route = matching.find(([method]) => method === req.method);
    if (!route) return matching.length ? fail(res, 405, 'Method not allowed') : fail(res, 404, 'Unknown Huntress mock route');
    return route[2](req, res, url, body, route[1].exec(path).slice(1));
  }

  // Test-only control routes: never part of Huntress's API, never behind its key.
  const entitiesOf = (items) => (Array.isArray(items) ? items : []).map((item) => {
    const agent = item?.agent_id !== undefined ? agentOf(item.agent_id) : null;
    return agent
      ? { id: String(agent.id), type: 'Agent', details: { hostname: agent.hostname, platform: agent.platform, os: agent.os, last_callback_at: agent.last_callback_at } }
      : item;
  });
  const organizationsOf = (ids) => ids.map((id) => organizationOf(id)).filter(Boolean).map((o) => ({ id: o.id, name: o.name }));

  function control(req, res, url, body) {
    const path = url.pathname.slice('/_mock/huntress/'.length).replace(/\/$/, '');
    const fields = req.method === 'POST' ? parse(body) : {};
    if (!fields) return fail(res, 400, 'The body must be a JSON object');
    const one = /^(agents|incidents|escalations|platform-actions)\/(\d+)$/.exec(path);
    const kind = one?.[1];
    const id = Number(one?.[2]);

    if (path === 'faults' && req.method === 'POST') {
      if (!fields.method || !fields.path || !fields.status) return fail(res, 400, 'method, path and status are required');
      faults.push({ method: fields.method, path: fields.path, status: fields.status, count: fields.count ?? 1 });
      return send(res, 204);
    }
    if (path === 'organizations' && req.method === 'POST') {
      const created = newId();
      const now = stamp();
      const organization = {
        account_id: base, name: `Testorganisasjon ${run} ${created}`, key: `test-${created}`, billable_identity_count: 0, sat_learner_count: 0,
        logs_sources_count: 0, identity_provider_tenant_id: null, report_recipients: [], created_at: now, updated_at: now, ...fields, id: created,
      };
      organizations.push(organization);
      return send(res, 201, organizationView(organization));
    }
    if (path === 'reports' && req.method === 'POST') {
      if (!organizationOf(fields.organization_id)) return fail(res, 400, 'organization_id must name an organization of the mock');
      // Last month unless the body names the first day of another.
      const now = new Date();
      const first = fields.period_start ? new Date(`${fields.period_start}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
      const created = newId();
      const { period_start: _start, ...rest } = fields;
      const report = {
        type: 'monthly_summary', period: `${first.toISOString().slice(0, 10)}...${next.toISOString().slice(0, 10)}`,
        agents_count: agents.filter((a) => a.organization_id === Number(fields.organization_id)).length, incidents_reported: 0, incidents_resolved: 0,
        signals_detected: 0, signals_investigated: 0, events_analyzed: 0, analyst_note: 'Synthetic report of the stand-in.',
        created_at: next.toISOString(), updated_at: next.toISOString(),
        ...rest, id: created, organization_id: Number(fields.organization_id),
      };
      reports.push(report);
      return send(res, 201, report);
    }
    if (path === 'agents' && req.method === 'POST') {
      if (!organizationOf(fields.organization_id)) return fail(res, 400, 'organization_id must name an organization of the mock');
      const created = newId();
      const agent = agentDefaults(created, Number(fields.organization_id), base, fields.hostname ?? `PC-${created}`, fields.platform ?? 'windows', fields);
      Object.assign(agent, { id: created, organization_id: Number(fields.organization_id) });
      agents.push(agent);
      return send(res, 201, agent);
    }
    if (path === 'incidents' && req.method === 'POST') {
      const organization = organizationOf(fields.organization_id);
      if (!organization) return fail(res, 400, 'organization_id must name an organization of the mock');
      if (fields.agent_id !== undefined && fields.agent_id !== null && !agentOf(fields.agent_id)) return fail(res, 400, 'agent_id must name an agent of the mock');
      const agent = fields.agent_id ? agentOf(fields.agent_id) : null;
      const severity = fields.severity ?? 'high';
      const created = newId();
      const now = stamp();
      const { remediations, ...rest } = fields;
      const incident = {
        account_id: base, agent_id: agent?.id ?? null, platform: agent?.platform ?? 'windows', status: 'sent', severity,
        subject: `${severity.toUpperCase()} - Incident on ${agent?.hostname ?? 'unknown host'} (${organization.name})`,
        summary: 'Synthetic incident of the stand-in: a scheduled task starts an unknown program.',
        body: '<p>Synthetic detail of the stand-in.</p>', indicator_types: ['footholds'], indicator_counts: { footholds: 1 },
        sent_at: now, closed_at: null, status_updated_at: now, updated_at: now, psa_ticket_eids: [], comments: [],
        ...rest, id: created, organization_id: organization.id,
        plan: (Array.isArray(remediations) ? remediations : [
          { type: 'assisted', action: 'Delete Scheduled Task', parameters: [{ name: 'task', description: '\\Synthetic' }] },
          { type: 'manual', action: 'Reset the password of the affected account', parameters: [{ name: 'account', description: 'TEST\\testbruker' }] },
        ]).map((r) => remediation(newId(), r.type ?? 'manual', r.action ?? 'Synthetic step', r.parameters ?? [], r.status ?? 'unapproved')),
      };
      incidents.push(incident);
      return send(res, 201, incidentView(incident, true));
    }
    if ((path === 'escalations' || path === 'platform-actions') && req.method === 'POST') {
      if (!Array.isArray(fields.organization_ids) || fields.organization_ids.some((o) => !organizationOf(o))) {
        return fail(res, 400, 'organization_ids must list organizations of the mock');
      }
      const escalation = path === 'escalations';
      const created = newId();
      const now = stamp();
      const { organization_ids: ids, entities, ...rest } = fields;
      const notice = {
        account: { id: base, name: account.name }, created_at: now, resolved_at: null, severity: 'high', status: 'open',
        subject: escalation ? 'Sign-in from an unexpected country' : 'Microsoft Defender has been disabled', subtype: null,
        type: escalation ? 'Unexpected Country Access' : 'Environmental Issue', type_code: escalation ? 'unexpected_country_access' : 'defender_disabled',
        psa_ticket_eids: [], updated_at: now, ...rest, id: created, organizations: organizationsOf(ids), entities: entitiesOf(entities),
      };
      (escalation ? escalations : platformActions).push(notice);
      return send(res, 201, noticeView(notice, true));
    }
    if (one && kind === 'agents') {
      const agent = agentOf(id);
      // An uninstalled agent is gone, but what the CRM sent about it can still be read back.
      if (!agent) return send(res, 404, { errors: ['No such agent'], posted: posted.get(`agent:${id}`) ?? {} });
      if (req.method === 'GET') return send(res, 200, { ...agent, pending_firewall_status: pending.get(agent.id) ?? null, posted: posted.get(`agent:${id}`) ?? {} });
      if (req.method === 'DELETE') {
        agents.splice(agents.indexOf(agent), 1);
        return send(res, 204);
      }
      if (fields.organization_id !== undefined && !organizationOf(fields.organization_id)) return fail(res, 400, 'organization_id must name an organization of the mock');
      Object.assign(agent, fields, { id: agent.id, organization_id: fields.organization_id !== undefined ? Number(fields.organization_id) : agent.organization_id });
      touch(agent);
      return send(res, 200, agent);
    }
    if (one && kind === 'incidents') {
      const incident = incidentOf(id);
      if (!incident) return fail(res, 404, 'No such incident');
      if (req.method === 'GET') return send(res, 200, { ...incidentView(incident, true), comments: incident.comments, posted: posted.get(`incident:${id}`) ?? {} });
      const { remediations, ...rest } = fields;
      const before = incident.status;
      Object.assign(incident, rest, { id: incident.id, organization_id: incident.organization_id });
      if (Array.isArray(remediations)) {
        incident.plan = remediations.map((r) => remediation(newId(), r.type ?? 'manual', r.action ?? 'Synthetic step', r.parameters ?? [], r.status ?? 'unapproved'));
      }
      const now = stamp();
      if (incident.status !== before) {
        incident.status_updated_at = rest.status_updated_at ?? now;
        if (['closed', 'dismissed', 'partner_dismissed'].includes(incident.status)) incident.closed_at = rest.closed_at ?? incident.closed_at ?? now;
      }
      incident.updated_at = rest.updated_at ?? now;
      return send(res, 200, incidentView(incident, true));
    }
    const comment = /^incidents\/(\d+)\/comments$/.exec(path);
    if (comment && req.method === 'POST') {
      const incident = incidentOf(comment[1]);
      if (!incident) return fail(res, 404, 'No such incident');
      if (typeof fields.body !== 'string' || !fields.body.trim()) return fail(res, 400, 'body is required');
      const now = stamp();
      const added = { id: newId(), body: fields.body, author: 'Huntress SOC', created_at: now, updated_at: now };
      incident.comments.push(added);
      incident.updated_at = now;
      return send(res, 201, added);
    }
    if (one && (kind === 'escalations' || kind === 'platform-actions')) {
      const notices = kind === 'escalations' ? escalations : platformActions;
      const notice = notices.find((n) => n.id === id);
      if (!notice) return fail(res, 404, 'No such notice');
      const key = `${kind === 'escalations' ? 'escalation' : 'platform_action'}:${id}`;
      if (req.method === 'GET') return send(res, 200, { ...noticeView(notice, true), posted: posted.get(key) ?? {} });
      const { organization_ids: ids, entities, ...rest } = fields;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((o) => !organizationOf(o)))) return fail(res, 400, 'organization_ids must list organizations of the mock');
      Object.assign(notice, rest, { id: notice.id });
      if (ids) notice.organizations = organizationsOf(ids);
      if (entities !== undefined) notice.entities = entitiesOf(entities);
      const now = stamp();
      if (notice.status === 'resolved') notice.resolved_at = rest.resolved_at ?? notice.resolved_at ?? now;
      notice.updated_at = rest.updated_at ?? now;
      return send(res, 200, noticeView(notice, true));
    }
    return fail(res, 404, 'Unknown Huntress control route');
  }

  /** Answers a Huntress request (true) or leaves it to the caller (false). */
  return function handle(req, res, url, body) {
    if (url.pathname.startsWith('/_mock/huntress/')) {
      control(req, res, url, body);
      return true;
    }
    if (url.pathname.startsWith('/huntress/v1/')) {
      api(req, res, url, body);
      return true;
    }
    if (url.pathname.startsWith('/huntress-files/') || url.pathname.startsWith('/huntress-blobs/')) {
      files(req, res, url);
      return true;
    }
    return false;
  };
}
