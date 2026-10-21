// Atera API v3 stand-in for external-apis.mjs: /api/v3/customers, /contacts, /tickets (+ workhoursrecords), /agents, /alerts and
// /customvalues (shapes from the Atera docs), plus test-only control routes under /_mock/atera that add a customer with a fresh
// organization number, its agents and alerts, and close an alert again (README). Data is in memory and new on every start.

export function createAtera({ customers, base, run, orgNumber, newId, send }) {
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

  // Customers mirror the PowerOffice ones (same organization numbers), so the mapping screen links them by org number.
  const ateraCustomers = [...customers.values()].map((c, index) => ({
    CustomerID: base + 500 + index,
    CustomerName: c.Name,
    BusinessNumber: c.OrganizationNumber,
    Domain: `${c.Name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.no`,
    Address: c.MailAddress.AddressLine1,
    City: c.MailAddress.City,
    ZipCodeStr: c.MailAddress.ZipCode,
    Country: 'NO',
    Phone: c.PhoneNumber,
  }));
  const ateraContacts = ateraCustomers.map((c, index) => ({
    EndUserID: base + 600 + index,
    CustomerID: c.CustomerID,
    Firstname: ['Ingrid', 'Ola', 'Kari'][index % 3],
    Lastname: `Kunde${run}`,
    Email: `bruker${index}@${c.Domain}`,
    Phone: '900 00 00' + index,
    InIgnoreMode: false,
  }));
  const ateraTickets = ateraCustomers.flatMap((c, index) => [
    {
      TicketID: base + 700 + index * 2,
      CustomerID: c.CustomerID,
      EndUserID: ateraContacts[index].EndUserID,
      TicketTitle: ['Skriver svarer ikke', 'Outlook krasjer', 'Ny ansatt trenger tilgang'][index % 3],
      TicketStatus: 'Open',
      TicketPriority: ['High', 'Medium', 'Low'][index % 3],
      TicketType: 'Incident',
      TicketSource: 'Email',
      TechnicianContactID: 4001,
      TechnicianEmail: 'tor.tekniker@vardahei.no',
      TechnicianFullName: 'Tor Tekniker',
      EndUserFirstName: ateraContacts[index].Firstname,
      EndUserLastName: ateraContacts[index].Lastname,
      EndUserEmail: ateraContacts[index].Email,
      TicketCreatedDate: hoursAgo(30 + index),
      FirstResponseDate: hoursAgo(29 + index),
    },
    {
      TicketID: base + 701 + index * 2,
      CustomerID: c.CustomerID,
      EndUserID: ateraContacts[index].EndUserID,
      TicketTitle: 'Månedlig vedlikehold',
      TicketStatus: 'Closed',
      TicketPriority: 'Low',
      TicketType: 'Request',
      TechnicianContactID: 4002,
      TechnicianEmail: 'nina.nett@vardahei.no',
      TechnicianFullName: 'Nina Nett',
      TicketCreatedDate: hoursAgo(200 + index),
      TicketResolvedDate: hoursAgo(190 + index),
    },
  ]);
  const ateraWorkHours = new Map(
    ateraTickets.map((ticket, index) => [
      ticket.TicketID,
      [
        {
          WorkHoursID: `wh-${ticket.TicketID}`,
          TechnicianContactID: ticket.TechnicianContactID,
          TechnicianEmail: ticket.TechnicianEmail,
          TechnicianFullName: ticket.TechnicianFullName,
          StartWorkHour: hoursAgo(28 + index),
          EndWorkHour: hoursAgo(27 + index),
          TimeSpentInMinutes: [60, 90, 45][index % 3],
          Billable: index % 4 !== 3,
          IsOnsite: index % 3 === 2,
          Description: 'Feilsøking og utbedring',
        },
      ],
    ]),
  );
  const ateraAgents = ateraCustomers.flatMap((c, index) =>
    [
      { suffix: 'PC', OSType: 'Work Station', OS: 'Windows 11 Pro', Online: true },
      { suffix: 'LAP', OSType: 'Work Station', OS: 'Windows 11 Pro', Online: false },
      { suffix: 'SRV', OSType: 'Server', OS: 'Windows Server 2022', Online: true },
    ].map((agent, n) => ({
      AgentID: `agent-${c.CustomerID}-${n}`,
      CustomerID: c.CustomerID,
      MachineName: `${agent.suffix}-${index + 1}${n}`,
      OSType: agent.OSType,
      OS: agent.OS,
      Online: agent.Online,
      LastSeen: hoursAgo(n),
    })),
  );
  const ateraAlerts = ateraCustomers.slice(0, 2).map((c, index) => ({
    AlertID: `alert-${c.CustomerID}`,
    CustomerID: c.CustomerID,
    Title: index === 0 ? 'Disken er nesten full (92 %)' : 'Sikkerhetskopi feilet',
    Severity: index === 0 ? 'Critical' : 'Warning',
    DeviceName: `SRV-${index + 1}2`,
    Created: hoursAgo(5 + index),
  }));
  const ateraCustomValues = new Map();
  const ateraPage = (res, url, items) => {
    const size = Number(url.searchParams.get('itemsInPage') ?? 50);
    const number = Number(url.searchParams.get('page') ?? 1);
    return send(res, 200, {
      items: items.slice((number - 1) * size, number * size),
      totalItemCount: items.length,
      page: number,
      itemsInPage: size,
      totalPages: Math.max(1, Math.ceil(items.length / size)),
    });
  };

  // A test's customer needs an organization number no other customer of this run has; numbers starting with 8 are also
  // known to the registry stand-in, so the CRM can create the organization with it.
  const issued = new Set(ateraCustomers.map((c) => c.BusinessNumber).filter(Boolean));
  const freshOrgNumber = () => {
    for (;;) {
      const candidate = orgNumber(Math.floor(Math.random() * 9_999_000));
      if (!issued.has(candidate)) {
        issued.add(candidate);
        return candidate;
      }
    }
  };
  const parse = (body) => {
    try {
      const value = body ? JSON.parse(body) : {};
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const customerOf = (id) => ateraCustomers.find((c) => c.CustomerID === Number(id));

  // Test-only control routes: never part of Atera's API, never behind its key.
  function control(req, res, url, body) {
    const path = url.pathname.slice('/_mock/atera/'.length);
    const removeAlert = path.match(/^alerts\/([^/]+)$/);
    if (removeAlert && req.method === 'DELETE') {
      // Closing an alert in Atera takes it off the open list; the CRM's next complete read resolves it.
      const index = ateraAlerts.findIndex((a) => String(a.AlertID) === decodeURIComponent(removeAlert[1]));
      if (index < 0) return send(res, 404, { message: 'No such alert' });
      ateraAlerts.splice(index, 1);
      return send(res, 204);
    }
    if (req.method !== 'POST' || !['customers', 'agents', 'alerts'].includes(path)) return send(res, 404, { message: 'Unknown Atera control route' });
    const fields = parse(body);
    if (!fields) return send(res, 400, { message: 'The body must be a JSON object' });
    if (path === 'customers') {
      const id = newId();
      const customer = { CustomerName: `Testkunde ${run} ${id} AS`, Country: 'NO', ...fields, CustomerID: id, BusinessNumber: fields.BusinessNumber ?? freshOrgNumber() };
      issued.add(customer.BusinessNumber);
      ateraCustomers.push(customer);
      return send(res, 201, customer);
    }
    if (!customerOf(fields.CustomerID)) return send(res, 400, { message: 'CustomerID must name a customer of the mock' });
    if (path === 'agents') {
      const id = newId();
      const agent = { MachineName: `PC-${id}`, OSType: 'Work Station', OS: 'Windows 11 Pro', Online: true, LastSeen: hoursAgo(0), ...fields, AgentID: `agent-${id}`, CustomerID: Number(fields.CustomerID) };
      ateraAgents.push(agent);
      return send(res, 201, agent);
    }
    // Atera's alert ids are numbers; newest first, like Atera's list.
    const alert = { Title: 'Testvarsel', Severity: 'Critical', Created: new Date().toISOString(), ...fields, AlertID: newId(), CustomerID: Number(fields.CustomerID) };
    ateraAlerts.unshift(alert);
    return send(res, 201, alert);
  }

  function api(req, res, url, body) {
    if (!req.headers['x-api-key']) return send(res, 401, { message: 'Missing X-API-KEY' });
    const path = url.pathname.slice('/api/v3/'.length);
    if (path === 'customers') return ateraPage(res, url, ateraCustomers);
    if (path === 'contacts' && req.method === 'GET') return ateraPage(res, url, ateraContacts);
    if (path === 'contacts' && req.method === 'POST') {
      const created = { ...JSON.parse(body), EndUserID: newId() };
      ateraContacts.push(created);
      return send(res, 200, { ActionID: created.EndUserID });
    }
    if (path === 'tickets' && req.method === 'GET') {
      const status = url.searchParams.get('ticketStatus');
      return ateraPage(res, url, status ? ateraTickets.filter((t) => t.TicketStatus === status) : ateraTickets);
    }
    if (path === 'tickets' && req.method === 'POST') {
      const request = JSON.parse(body);
      const contact = ateraContacts.find((c) => c.EndUserID === request.EndUserID);
      const ticket = {
        TicketID: newId(), CustomerID: contact?.CustomerID, EndUserID: request.EndUserID, TicketTitle: request.TicketTitle,
        TicketStatus: 'Open', TicketPriority: request.TicketPriority, TicketType: request.TicketType, TicketSource: 'CRM',
        TicketCreatedDate: new Date().toISOString(),
      };
      ateraTickets.unshift(ticket);
      ateraWorkHours.set(ticket.TicketID, []);
      return send(res, 200, { ActionID: ticket.TicketID });
    }
    const workHours = path.match(/^tickets\/(\d+)\/workhoursrecords$/);
    if (workHours) return send(res, 200, ateraWorkHours.get(Number(workHours[1])) ?? []);
    if (path === 'agents') return ateraPage(res, url, ateraAgents);
    if (path === 'alerts') return ateraPage(res, url, ateraAlerts);
    const customValue = path.match(/^customvalues\/customerfield\/(\d+)\/(.+)$/);
    if (customValue) {
      const key = `${customValue[1]}/${decodeURIComponent(customValue[2])}`;
      if (req.method === 'PUT') {
        ateraCustomValues.set(key, JSON.parse(body).Value);
        return send(res, 200, {});
      }

      return send(res, 200, [{ FieldName: decodeURIComponent(customValue[2]), ValueAsString: ateraCustomValues.get(key) ?? '' }]);
    }

    const customer = path.match(/^customers\/(\d+)$/);
    if (customer) {
      const found = customerOf(customer[1]);
      return found ? send(res, 200, found) : send(res, 404, { message: 'Not found' });
    }

    return send(res, 404, { message: 'Unknown Atera mock route' });
  }

  /** Answers an Atera request (true) or leaves it to the caller (false). */
  return function handle(req, res, url, body) {
    if (url.pathname.startsWith('/_mock/atera/')) {
      control(req, res, url, body);
      return true;
    }
    if (url.pathname.startsWith('/api/v3/')) {
      api(req, res, url, body);
      return true;
    }
    return false;
  };
}
