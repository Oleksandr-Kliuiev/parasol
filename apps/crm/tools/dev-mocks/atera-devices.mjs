// Agents of the Atera stand-in (atera.mjs) with what Atera API v3 says about the computer (M40): DeviceGuid, AppViewUrl, serial
// number, MAC and IP addresses, hardware, system, who is logged in, and the Windows updates under
// /agents/{DeviceGuid}/installed-patches and /available-patches (field names from Atera's OpenAPI file). Test-only control routes
// add an agent, change one (it goes silent, it is renamed) or take it away (README).

const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

/** A DeviceGuid of its own for every agent id, so one start of the mock always answers the same. */
export const deviceGuid = (id) => {
  const hex = [...String(id)].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 0xffffffffffff, 7).toString(16).padStart(12, '0');
  return `5369e175-0000-4000-8000-${hex}`;
};

/** What a new agent of the mock reports unless a test says otherwise; numbers are synthetic, units as Atera's API (none). */
export function agentDefaults(id, machineName, os) {
  const n = Number(String(id).replace(/\D/g, '').slice(-6) || 1);
  const guid = deviceGuid(id);
  const mac = (last) => `00:1A:2B:${((n >> 8) & 0xff).toString(16).padStart(2, '0')}:${(n & 0xff).toString(16).padStart(2, '0')}:${last}`.toUpperCase();
  const windows = /windows/i.test(os ?? '');
  return {
    DeviceGuid: guid,
    AppViewUrl: `https://atera.example.invalid/Admin#/rmm/device/${guid}/agent`,
    DomainName: 'KUNDE',
    CurrentLoggedUsers: windows ? `KUNDE\\bruker${n % 7}` : null,
    LastLoginUser: windows ? `bruker${n % 7}` : null,
    Vendor: 'Dell Inc.',
    VendorBrandModel: /server/i.test(os ?? '') ? 'PowerEdge T150' : 'Latitude 5440',
    VendorSerialNumber: `SN${String(n).padStart(8, '0')}`,
    Motherboard: 'Dell Inc. 0XYZ12',
    Processor: '13th Gen Intel(R) Core(TM) i5-1345U',
    ProcessorCoresCount: 10,
    ProcessorClock: '1.6',
    Memory: 16384,
    BiosVersion: '1.15.0',
    OSVersion: '23H2',
    OSBuild: '22631.4317',
    MacAddresses: [mac('10'), mac('11')],
    IpAddresses: [`10.0.${n % 250}.${10 + (n % 200)}`],
    ReportedFromIP: '203.0.113.10',
    HardwareDisks: [{ Drive: 'C:', Free: 120.5, Used: 355.4, Total: 475.9 }],
    LastRebootTime: hoursAgo(30),
    AgentVersion: '1.8.7.4',
    // Not Atera fields: what the patch routes answer for this agent. Atera reports Windows updates only.
    InstalledPatches: windows ? [
      { name: '2026-10 Cumulative Update for Windows 11 Version 23H2 for x64-based Systems (KB5044284)', class: 'Security Updates', kbId: 'KB5044284', installDate: hoursAgo(72) },
      { name: 'Security Intelligence Update for Microsoft Defender Antivirus - KB2267602', class: 'Definition Updates', kbId: 'KB2267602', installDate: hoursAgo(20) },
    ] : [],
    AvailablePatches: windows ? [
      { name: '2026-10 .NET 8.0.11 Security Update for x64 Client (KB5045993)', class: 'Security Updates', kbId: 'KB5045993', status: 'Pending' },
    ] : [],
  };
}

export function createAteraDevices({ agents, customerOf, newId, send, page, parse }) {
  const byGuid = (guid) => agents.find((a) => String(a.DeviceGuid).toLowerCase() === String(guid).toLowerCase());
  const byId = (id) => agents.findIndex((a) => String(a.AgentID) === String(id));

  // Test-only control routes: never part of Atera's API, never behind its key.
  function control(req, res, path, body) {
    const one = path.match(/^agents\/([^/]+)$/);
    if (one) {
      const index = byId(decodeURIComponent(one[1]));
      if (index < 0) return send(res, 404, { message: 'No such agent' }), true;
      if (req.method === 'DELETE') {
        // Taken away in "Atera": the CRM's next complete agent read marks the device removed.
        agents.splice(index, 1);
        return send(res, 204), true;
      }
      if (req.method !== 'POST') return false;
      const fields = parse(body);
      if (!fields) return send(res, 400, { message: 'The body must be a JSON object' }), true;
      // A change of the agent: it goes silent (Online false, LastSeen days ago), gets another name or other keys.
      agents[index] = { ...agents[index], ...fields, AgentID: agents[index].AgentID, CustomerID: agents[index].CustomerID };
      return send(res, 200, agents[index]), true;
    }
    if (path !== 'agents' || req.method !== 'POST') return false;
    const fields = parse(body);
    if (!fields) return send(res, 400, { message: 'The body must be a JSON object' }), true;
    if (!customerOf(fields.CustomerID)) return send(res, 400, { message: 'CustomerID must name a customer of the mock' }), true;
    const id = newId();
    const os = fields.OS ?? 'Windows 11 Pro';
    const name = fields.MachineName ?? `PC-${id}`;
    const agent = {
      MachineName: name, OSType: 'Work Station', OS: os, Online: true, LastSeen: hoursAgo(0), ...agentDefaults(`agent-${id}`, name, os),
      ...fields, AgentID: `agent-${id}`, CustomerID: Number(fields.CustomerID),
    };
    agents.push(agent);
    return send(res, 201, agent), true;
  }

  function api(req, res, url, path) {
    if (path === 'agents' && req.method === 'GET') {
      // The list carries Atera's fields only; what the patch routes answer stays out of it.
      return page(res, url, agents.map(({ InstalledPatches, AvailablePatches, ...agent }) => agent)), true;
    }
    const patches = path.match(/^agents\/([^/]+)\/(installed|available)-patches$/);
    if (patches && req.method === 'GET') {
      const agent = byGuid(decodeURIComponent(patches[1]));
      if (!agent) return send(res, 404, { title: 'Not Found', status: 404 }), true;
      const installed = patches[2] === 'installed';
      return send(res, 200, {
        deviceGuid: agent.DeviceGuid,
        timestamp: hoursAgo(1),
        [installed ? 'installedUpdates' : 'availableUpdates']: (installed ? agent.InstalledPatches : agent.AvailablePatches) ?? [],
      }), true;
    }
    return false;
  }

  return { control, api };
}
