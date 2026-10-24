// Atera ticket routes of the stand-in (M39.2, M39.3), called by atera.mjs: one ticket (GET, and POST to change status, priority or
// technician), its conversation (GET, and POST a technician's reply or internal note), the tickets changed since a date
// (/tickets/lastmodified) and recording work hours (POST /tickets/{id}/workhours). Shapes follow Atera's v3 API as the PSAtera module
// uses it. Test-only control routes under /_mock/atera add tickets, technicians and end-user comments, read a ticket back with
// everything the CRM sent, and make the next requests to a route fail (README).

export function createAteraTickets({ tickets, workHours, contacts, customerOf, newId, send, page, parse }) {
  // Change times only ever grow, so a reader's cursor at one change never hides another made in the same millisecond.
  let lastStamp = 0;
  const stamp = () => new Date((lastStamp = Math.max(Date.now(), lastStamp + 1))).toISOString();
  const touch = (ticket) => { ticket.TicketLastModified = stamp(); };
  const technicians = new Map([
    [4001, { TechnicianContactID: 4001, FullName: 'Tor Tekniker', Email: 'tor.tekniker@vardahei.no' }],
    [4002, { TechnicianContactID: 4002, FullName: 'Nina Nett', Email: 'nina.nett@vardahei.no' }],
    // The development sign-in's employee: the ticket sync maps this technician to them by e-mail, so they can write as it.
    [4003, { TechnicianContactID: 4003, FullName: 'Dev Admin', Email: 'admin@dev.local' }],
  ]);
  const comments = new Map(tickets.map((ticket) => [ticket.TicketID, [
    {
      CommentID: newId(), TicketID: ticket.TicketID, CommentText: `Hei, ${ticket.TicketTitle.toLowerCase()}. Kan dere se på det?`,
      CommentDate: ticket.TicketCreatedDate, IsInternal: false, EnduserID: ticket.EndUserID,
      FirstName: ticket.EndUserFirstName ?? null, LastName: ticket.EndUserLastName ?? null, Email: ticket.EndUserEmail ?? null,
    },
  ]]));
  for (const ticket of tickets) ticket.TicketLastModified ??= ticket.TicketCreatedDate;

  // Faults a test asked for: the next `count` requests with this method and path answer `status` (and change nothing).
  const faults = [];
  const fault = (method, path) => {
    const index = faults.findIndex((f) => f.method === method && (f.path === path || (f.path.endsWith('*') && path.startsWith(f.path.slice(0, -1)))));
    if (index < 0) return null;
    const found = faults[index];
    if (--found.count <= 0) faults.splice(index, 1);
    return found.status;
  };

  const ticketOf = (id) => tickets.find((t) => t.TicketID === Number(id));
  const assign = (ticket, technicianId) => {
    const technician = technicians.get(Number(technicianId));
    if (!technician) return false;
    ticket.TechnicianContactID = technician.TechnicianContactID;
    ticket.TechnicianFullName = technician.FullName;
    ticket.TechnicianEmail = technician.Email;
    return true;
  };

  /** Answers an Atera API request about tickets (true) or leaves it to the caller (false). */
  function api(req, res, url, body, path) {
    const failed = fault(req.method, `/api/v3/${path}`);
    if (failed) return send(res, failed, { message: 'Synthetic failure' }), true;
    if (path === 'tickets/lastmodified' && req.method === 'GET') {
      const since = new Date(url.searchParams.get('date') ?? 0);
      return page(res, url, tickets.filter((t) => new Date(t.TicketLastModified) > since)), true;
    }
    const comment = path.match(/^tickets\/(\d+)\/comments$/);
    if (comment) {
      const ticket = ticketOf(comment[1]);
      if (!ticket) return send(res, 404, { message: 'No such ticket' }), true;
      if (req.method === 'GET') return page(res, url, comments.get(ticket.TicketID) ?? []), true;
      const posted = parse(body);
      const details = posted?.TechnicianCommentDetails;
      const technician = technicians.get(Number(details?.TechnicianId));
      if (!posted?.CommentText || !technician) return send(res, 400, { message: 'CommentText and a known TechnicianCommentDetails.TechnicianId are required' }), true;
      const created = {
        CommentID: newId(), TicketID: ticket.TicketID, CommentText: posted.CommentText, CommentDate: posted.CommentTimestampUTC ?? new Date().toISOString(),
        IsInternal: Boolean(details.IsInternal), TechnicianContactID: technician.TechnicianContactID, TechnicianFullName: technician.FullName, TechnicianEmail: technician.Email,
      };
      comments.set(ticket.TicketID, [...(comments.get(ticket.TicketID) ?? []), created]);
      touch(ticket);
      return send(res, 200, { ActionID: created.CommentID }), true;
    }
    const hours = path.match(/^tickets\/(\d+)\/workhours$/);
    if (hours && req.method === 'POST') {
      const ticket = ticketOf(hours[1]);
      if (!ticket) return send(res, 404, { message: 'No such ticket' }), true;
      const posted = parse(body);
      const technician = technicians.get(Number(posted?.TechnicianContactID));
      const start = new Date(posted?.StartWorkHour); const end = new Date(posted?.EndWorkHour);
      if (!technician || Number.isNaN(start.getTime()) || !(end > start)) return send(res, 400, { message: 'A known technician and a start before the end are required' }), true;
      const record = {
        WorkHoursID: `wh-${newId()}`, TicketID: ticket.TicketID, TechnicianContactID: technician.TechnicianContactID, TechnicianEmail: technician.Email,
        TechnicianFullName: technician.FullName, StartWorkHour: start.toISOString(), EndWorkHour: end.toISOString(),
        TimeSpentInMinutes: Math.round((end - start) / 60_000), Billable: posted.Billiable !== false, IsOnsite: Boolean(posted.OnCustomerSite),
        Description: posted.Comments ?? null,
      };
      workHours.set(ticket.TicketID, [...(workHours.get(ticket.TicketID) ?? []), record]);
      touch(ticket);
      return send(res, 200, { ActionID: record.WorkHoursID }), true;
    }
    const one = path.match(/^tickets\/(\d+)$/);
    if (one) {
      const ticket = ticketOf(one[1]);
      if (!ticket) return send(res, 404, { message: 'No such ticket' }), true;
      if (req.method === 'POST') {
        const posted = parse(body);
        if (!posted) return send(res, 400, { message: 'The body must be a JSON object' }), true;
        if (posted.TechnicianContactID !== undefined && !assign(ticket, posted.TechnicianContactID)) return send(res, 400, { message: 'Unknown technician' }), true;
        if (posted.TicketStatus) {
          ticket.TicketStatus = posted.TicketStatus;
          if (['Resolved', 'Closed'].includes(posted.TicketStatus)) ticket.TicketResolvedDate ??= new Date().toISOString();
          else delete ticket.TicketResolvedDate;
        }
        if (posted.TicketPriority) ticket.TicketPriority = posted.TicketPriority;
        touch(ticket);
        return send(res, 200, { ActionID: ticket.TicketID }), true;
      }
      return send(res, 200, ticket), true;
    }
    return false;
  }

  /** Answers a test-only control route about tickets (true) or leaves it to the caller (false). */
  function control(req, res, path, body) {
    if (path === 'faults' && req.method === 'POST') {
      const asked = parse(body);
      if (!asked?.method || !asked?.path || !asked?.status) return send(res, 400, { message: 'method, path and status are required' }), true;
      faults.push({ method: asked.method, path: asked.path, status: asked.status, count: asked.count ?? 1 });
      return send(res, 204), true;
    }
    if (path === 'technicians' && req.method === 'POST') {
      const asked = parse(body);
      if (!asked?.FullName) return send(res, 400, { message: 'FullName is required' }), true;
      const technician = { TechnicianContactID: Number(asked.TechnicianContactID ?? newId()), FullName: asked.FullName, Email: asked.Email ?? null };
      technicians.set(technician.TechnicianContactID, technician);
      return send(res, 201, technician), true;
    }
    if (path === 'tickets' && req.method === 'POST') {
      const asked = parse(body);
      const customer = asked && customerOf(asked.CustomerID);
      if (!customer) return send(res, 400, { message: 'CustomerID must name a customer of the mock' }), true;
      const contact = contacts.find((c) => c.CustomerID === customer.CustomerID);
      const id = newId();
      const ticket = {
        TicketTitle: `Testsak ${id}`, TicketStatus: 'Open', TicketPriority: 'Medium', TicketType: 'Incident', TicketSource: 'Email',
        EndUserID: contact?.EndUserID, EndUserFirstName: contact?.Firstname, EndUserLastName: contact?.Lastname, EndUserEmail: contact?.Email,
        TicketCreatedDate: new Date().toISOString(), ...asked, TicketID: id, CustomerID: customer.CustomerID,
      };
      if (asked.TechnicianContactID !== undefined && !assign(ticket, asked.TechnicianContactID)) return send(res, 400, { message: 'Unknown technician' }), true;
      touch(ticket);
      tickets.unshift(ticket);
      workHours.set(id, []);
      comments.set(id, []);
      return send(res, 201, ticket), true;
    }
    const endUser = path.match(/^tickets\/(\d+)\/comments$/);
    if (endUser && req.method === 'POST') {
      const ticket = ticketOf(endUser[1]);
      const asked = parse(body);
      if (!ticket || !asked?.CommentText) return send(res, 400, { message: 'A ticket of the mock and CommentText are required' }), true;
      const created = {
        CommentID: newId(), TicketID: ticket.TicketID, CommentText: asked.CommentText, CommentDate: new Date().toISOString(), IsInternal: false,
        EnduserID: ticket.EndUserID, FirstName: ticket.EndUserFirstName ?? null, LastName: ticket.EndUserLastName ?? null, Email: ticket.EndUserEmail ?? null,
      };
      comments.set(ticket.TicketID, [...(comments.get(ticket.TicketID) ?? []), created]);
      touch(ticket);
      return send(res, 201, created), true;
    }
    const state = path.match(/^tickets\/(\d+)$/);
    if (state && req.method === 'GET') {
      const ticket = ticketOf(state[1]);
      return ticket ? send(res, 200, { ...ticket, Comments: comments.get(ticket.TicketID) ?? [], WorkHours: workHours.get(ticket.TicketID) ?? [] })
        : send(res, 404, { message: 'No such ticket' }), true;
    }
    return false;
  }

  return { api, control };
}
