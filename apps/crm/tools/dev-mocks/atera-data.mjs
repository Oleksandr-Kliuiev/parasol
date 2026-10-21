// Seed data of the Atera stand-in (atera.mjs): customers that mirror the PowerOffice ones (same organization numbers), a contact
// and two tickets per customer with one work-hour row each, three agents per customer and two open alerts. New on every start.

export const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

export function seedAtera({ customers, base, run }) {
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
  return { ateraCustomers, ateraContacts, ateraTickets, ateraWorkHours, ateraAgents, ateraAlerts };
}
