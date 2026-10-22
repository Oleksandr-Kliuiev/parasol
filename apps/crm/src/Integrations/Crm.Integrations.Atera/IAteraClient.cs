namespace Crm.Integrations.Atera;

public interface IAteraClient
{
    IAsyncEnumerable<AteraCustomer> GetCustomersAsync(CancellationToken cancellationToken);

    IAsyncEnumerable<AteraContact> GetContactsAsync(CancellationToken cancellationToken);

    Task<AteraCustomer?> GetCustomerAsync(long customerId, CancellationToken cancellationToken);

    Task<long> CreateCustomerAsync(AteraCustomerWrite customer, CancellationToken cancellationToken);

    Task UpdateCustomerAsync(long customerId, AteraCustomerWrite customer, CancellationToken cancellationToken);

    /// <summary>Current value of a customer custom field, or null when it is not set.</summary>
    Task<string?> GetCustomerFieldAsync(long customerId, string fieldName, CancellationToken cancellationToken);

    Task SetCustomerFieldAsync(long customerId, string fieldName, string value, CancellationToken cancellationToken);

    /// <summary>Tickets, newest first; <paramref name="status"/> filters by ticket status (Open, Pending, Resolved, Closed).</summary>
    IAsyncEnumerable<AteraTicket> GetTicketsAsync(string? status, CancellationToken cancellationToken);

    /// <summary>Every page of the ticket's work hours; rows that cannot be used are counted, never silently lost (DEV-19).</summary>
    Task<AteraWorkHoursResult> GetWorkHoursAsync(long ticketId, CancellationToken cancellationToken);

    /// <summary>One customer's tickets, newest first; used to find a ticket whose creation got no answer.</summary>
    IAsyncEnumerable<AteraTicket> GetCustomerTicketsAsync(long customerId, CancellationToken cancellationToken);

    IAsyncEnumerable<AteraAgent> GetAgentsAsync(CancellationToken cancellationToken);

    IAsyncEnumerable<AteraAlert> GetAlertsAsync(string? status, CancellationToken cancellationToken);

    /// <summary>The installed or available Windows updates of an agent by its DeviceGuid (M40); null when Atera does not know it.</summary>
    Task<AteraPatchList?> GetPatchesAsync(string deviceGuid, bool installed, CancellationToken cancellationToken);

    Task<long> CreateTicketAsync(AteraTicketWrite ticket, CancellationToken cancellationToken);

    Task<long> CreateContactAsync(AteraContactWrite contact, CancellationToken cancellationToken);

    /// <summary>One ticket as Atera has it now; null when Atera does not know it (M39.2).</summary>
    Task<AteraTicket?> GetTicketAsync(long ticketId, CancellationToken cancellationToken);

    /// <summary>Tickets Atera changed after <paramref name="since"/> (<c>/tickets/lastmodified</c>), every page.</summary>
    IAsyncEnumerable<AteraTicket> GetModifiedTicketsAsync(DateTimeOffset since, CancellationToken cancellationToken);

    /// <summary>The whole conversation of a ticket, every page; an entry without an id fails the read (M39.2).</summary>
    Task<IReadOnlyList<AteraComment>> GetTicketCommentsAsync(long ticketId, CancellationToken cancellationToken);

    /// <summary>Adds a comment as a technician; the id Atera answers with, when it does.</summary>
    Task<string?> CreateTicketCommentAsync(long ticketId, AteraCommentWrite comment, CancellationToken cancellationToken);

    /// <summary>Changes the given fields of a ticket (status, priority, technician); the others keep Atera's values.</summary>
    Task UpdateTicketAsync(long ticketId, AteraTicketUpdate update, CancellationToken cancellationToken);

    /// <summary>Records work on a ticket (M39.3); the id Atera answers with, when it does.</summary>
    Task<string?> CreateWorkHoursAsync(long ticketId, AteraWorkHoursWrite hours, CancellationToken cancellationToken);
}
