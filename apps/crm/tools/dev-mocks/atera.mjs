// Atera API v3 stand-in for external-apis.mjs: /api/v3/customers, /contacts, /tickets (+ workhoursrecords), /agents, /alerts and
// /customvalues (shapes from the Atera docs), with one ticket, its conversation and its changes in atera-tickets.mjs, plus
// test-only control routes under /_mock/atera that add a customer with a fresh organization number, its agents, alerts and
// tickets, and close an alert again (README). Data is in memory and new on every start.

import { seedAtera } from './atera-data.mjs';
import { createAteraDevices } from './atera-devices.mjs';
import { createAteraTickets } from './atera-tickets.mjs';

export function createAtera({ customers, base, run, orgNumber, newId, send }) {
  const { ateraCustomers, ateraContacts, ateraTickets, ateraWorkHours, ateraAgents, ateraAlerts } = seedAtera({ customers, base, run });
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
  const ticketRoutes = createAteraTickets({
    tickets: ateraTickets, workHours: ateraWorkHours, contacts: ateraContacts, customerOf, newId, send, page: ateraPage, parse,
  });
  const deviceRoutes = createAteraDevices({ agents: ateraAgents, customerOf, newId, send, page: ateraPage, parse });

  // Test-only control routes: never part of Atera's API, never behind its key.
  function control(req, res, url, body) {
    const path = url.pathname.slice('/_mock/atera/'.length);
    if (ticketRoutes.control(req, res, path, body)) return;
    if (deviceRoutes.control(req, res, path, body)) return;
    const removeAlert = path.match(/^alerts\/([^/]+)$/);
    if (removeAlert && req.method === 'DELETE') {
      // Closing an alert in Atera takes it off the open list; the CRM's next complete read resolves it.
      const index = ateraAlerts.findIndex((a) => String(a.AlertID) === decodeURIComponent(removeAlert[1]));
      if (index < 0) return send(res, 404, { message: 'No such alert' });
      ateraAlerts.splice(index, 1);
      return send(res, 204);
    }
    if (req.method !== 'POST' || !['customers', 'alerts'].includes(path)) return send(res, 404, { message: 'Unknown Atera control route' });
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
    // Atera's alert ids are numbers; newest first, like Atera's list.
    const alert = { Title: 'Testvarsel', Severity: 'Critical', Created: new Date().toISOString(), ...fields, AlertID: newId(), CustomerID: Number(fields.CustomerID) };
    ateraAlerts.unshift(alert);
    return send(res, 201, alert);
  }

  function api(req, res, url, body) {
    // Atera's v3 key, or a token in Authorization: Bearer (M39.0); the stand-in checks only that one of them is there.
    if (!req.headers['x-api-key'] && !/^Bearer \S+$/.test(req.headers.authorization ?? '')) return send(res, 401, { message: 'Missing X-API-KEY or bearer token' });
    const path = url.pathname.slice('/api/v3/'.length);
    if (ticketRoutes.api(req, res, url, body, path)) return;
    if (deviceRoutes.api(req, res, url, path)) return;
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
        TicketCreatedDate: new Date().toISOString(), TicketLastModified: new Date().toISOString(),
      };
      ateraTickets.unshift(ticket);
      ateraWorkHours.set(ticket.TicketID, []);
      return send(res, 200, { ActionID: ticket.TicketID });
    }
    const workHours = path.match(/^tickets\/(\d+)\/workhoursrecords$/);
    if (workHours) return send(res, 200, ateraWorkHours.get(Number(workHours[1])) ?? []);
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
