// Seed data of the Huntress stand-in (huntress.mjs, M41): one account, two organizations, their agents, an incident report waiting
// for the partner, an escalation, a platform action and monthly summary reports. Field names as Huntress API v1's reference has
// them (OpenAPI at api.huntress.io/v1/swagger_doc.json). Synthetic only; ids derive from the run's `base`, so they differ per start.

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const hours = (n) => ago(n * 3_600_000);
const days = (n) => ago(n * 86_400_000);
const hex = (n) => n.toString(16).padStart(6, '0').slice(-6);

/** The newest agent versions of the stand-in per platform; an agent below them counts as outdated in the usage. */
export const NEWEST = { windows: '0.14.38', darwin: '1.6.2', linux: '0.9.14' };

/** An agent with every field the reference names, healthy and current unless `extra` says otherwise. */
export function agentDefaults(id, organizationId, accountId, hostname, platform = 'windows', extra = {}) {
  const windows = platform === 'windows';
  return {
    id,
    account_id: accountId,
    organization_id: organizationId,
    hostname,
    platform,
    os: windows ? 'Windows 11 Pro' : platform === 'darwin' ? 'macOS 15.1' : 'Ubuntu 24.04 LTS',
    os_build_version: windows ? '26100' : null,
    os_major: windows ? 10 : null,
    os_minor: windows ? 0 : null,
    os_patch: null,
    win_build_number: windows ? 26100 : null,
    version: NEWEST[platform] ?? NEWEST.windows,
    edr_version: windows ? '0.3.20' : null,
    arch: 'x86_64',
    serial_number: `SN-${id}`,
    // A universal (not locally administered) address, so the CRM's machine matcher may use it as a key.
    mac_addresses: [`00:15:5d:${hex(id).slice(0, 2)}:${hex(id).slice(2, 4)}:${hex(id).slice(4, 6)}`],
    ipv4_address: `10.0.${id % 200}.${(id % 50) + 10}`,
    ipv4_addresses: [`10.0.${id % 200}.${(id % 50) + 10}`],
    external_ip: '198.51.100.10',
    domain_name: 'WORKGROUP',
    defender_status: windows ? 'Healthy' : null,
    defender_substatus: windows ? 'Up to date' : null,
    defender_policy_status: windows ? 'Compliant' : null,
    last_survey_at: windows ? hours(2) : null,
    firewall_status: 'Disabled',
    tamper_protection_configured: windows ? true : null,
    tamper_protection_actual: windows ? true : null,
    tags: [],
    last_callback_at: hours(0.2),
    created_at: days(120),
    updated_at: hours(0.2),
    ...extra,
  };
}

/** A remediation step as an incident report carries it. */
export const remediation = (id, type, action, parameters, status = 'unapproved') => ({
  id, type, action, parameters, status, approved_at: null, approved_by: null, completed_at: null,
});

export function seedHuntress({ base, run }) {
  const account = { id: base, name: `Vardahei stand-in ${run}`, subdomain: 'vardahei-mock', status: 'enabled', support_type: 'not_applicable' };
  const organizations = [
    { id: base + 1, account_id: base, name: 'Fjord IT AS', key: 'fjord-it', billable_identity_count: 24, sat_learner_count: 18, logs_sources_count: 0,
      identity_provider_tenant_id: '00000000-0000-4000-8000-00000000f001', report_recipients: [], created_at: days(300), updated_at: days(3) },
    { id: base + 2, account_id: base, name: 'Havbris Test AS', key: 'havbris-test', billable_identity_count: 7, sat_learner_count: 0, logs_sources_count: 0,
      identity_provider_tenant_id: null, report_recipients: [], created_at: days(200), updated_at: days(9) },
  ];
  const [fjord, havbris] = organizations;
  const agents = [
    agentDefaults(base + 11, fjord.id, base, 'SRV-01', 'windows', {
      os: 'Windows Server 2022 Standard', os_build_version: '20348', win_build_number: 20348, serial_number: 'VMW-4C4C4544-0042', tags: ['server'],
    }),
    // Defender does not protect this one, by Huntress's word.
    agentDefaults(base + 12, fjord.id, base, 'PC-17', 'windows', {
      defender_status: 'Unhealthy', defender_substatus: 'Real-time protection disabled', defender_policy_status: 'Non-compliant',
    }),
    // Still on an older agent version than the rest of the account's Windows agents.
    agentDefaults(base + 13, fjord.id, base, 'PC-22', 'windows', { os: 'Windows 10 Pro', version: '0.13.212', os_build_version: '19045', win_build_number: 19045 }),
    // Has not called back for ten days.
    agentDefaults(base + 14, havbris.id, base, 'LAPTOP-09', 'windows', { last_callback_at: days(10), updated_at: days(10), last_survey_at: days(10) }),
    agentDefaults(base + 15, havbris.id, base, 'MAC-03', 'darwin'),
  ];
  const pc17 = agents[1];
  const incidents = [{
    id: base + 31,
    account_id: base,
    organization_id: fjord.id,
    agent_id: pc17.id,
    platform: 'windows',
    status: 'sent',
    severity: 'high',
    subject: `HIGH - Incident on ${pc17.hostname} (${fjord.name})`,
    summary: 'Huntress found a scheduled task that starts an unknown program at every sign-in. Remove the task and reset the password of the account that created it.',
    body: '<p>Persistence by a scheduled task: <code>\\Updater</code> runs <code>C:\\ProgramData\\upd\\upd.exe</code> at every sign-in.</p>',
    indicator_types: ['footholds', 'process_detections'],
    indicator_counts: { footholds: 1, monitored_files: 0, process_detections: 2, ransomware_canaries: 0, antivirus_detections: 0 },
    sent_at: hours(5),
    closed_at: null,
    status_updated_at: hours(5),
    updated_at: hours(5),
    psa_ticket_eids: [],
    plan: [
      remediation(base + 32, 'assisted', 'Delete Scheduled Task', [{ name: 'task', description: '\\Updater' }]),
      remediation(base + 33, 'manual', 'Reset the password of the affected account', [{ name: 'account', description: 'FJORD\\testbruker' }]),
    ],
    comments: [{ id: base + 34, body: 'We isolated nothing yet: the task has not reached other hosts.', author: 'Huntress SOC', created_at: hours(5), updated_at: hours(5) }],
  }];
  const escalations = [{
    id: base + 41,
    account: { id: base, name: account.name },
    organizations: [{ id: fjord.id, name: fjord.name }],
    created_at: hours(20),
    resolved_at: null,
    severity: 'high',
    status: 'open',
    subject: 'Sign-in from an unexpected country',
    subtype: 'BR',
    type: 'Unexpected Country Access',
    type_code: 'unexpected_country_access',
    psa_ticket_eids: [],
    updated_at: hours(20),
    entities: [{ id: 'identity-1', type: 'Identity', details: { display_name: 'Test Bruker', user_principal_name: 'testbruker@fjord-it.example.invalid' } }],
  }];
  const platformActions = [{
    id: base + 51,
    account: { id: base, name: account.name },
    organizations: [{ id: fjord.id, name: fjord.name }],
    created_at: hours(30),
    resolved_at: null,
    severity: 'high',
    status: 'open',
    subject: 'Microsoft Defender has been disabled',
    subtype: null,
    type: 'Environmental Issue',
    type_code: 'defender_disabled',
    psa_ticket_eids: [],
    updated_at: hours(30),
    entities: [{
      id: String(pc17.id), type: 'Agent',
      details: { hostname: pc17.hostname, platform: pc17.platform, os: pc17.os, last_callback_at: pc17.last_callback_at },
    }],
  }];
  // Three full months of summary reports for each organization.
  const reports = [];
  const now = new Date();
  for (const organization of organizations) {
    for (let back = 3; back >= 1; back--) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 1));
      const id = base + 60 + reports.length + 1;
      const fleet = agents.filter((a) => a.organization_id === organization.id).length;
      reports.push({
        id, organization_id: organization.id, type: 'monthly_summary', period: `${start.toISOString().slice(0, 10)}...${end.toISOString().slice(0, 10)}`,
        agents_count: fleet, windows_agent_count: fleet, macos_agent_count: 0, servers_agent_count: organization === fjord ? 1 : 0,
        incidents_reported: back === 1 && organization === fjord ? 1 : 0, incidents_resolved: 0,
        signals_detected: 40 * back + fleet, signals_investigated: 12 * back, events_analyzed: 150_000 * back + 1_000 * fleet,
        // No `url`: the stand-in answers with a link to its own report file (M43), on the host the request came to.
        analyst_note: 'Synthetic report of the stand-in.',
        created_at: end.toISOString(), updated_at: end.toISOString(),
      });
    }
  }
  return { account, organizations, agents, incidents, escalations, platformActions, reports };
}
