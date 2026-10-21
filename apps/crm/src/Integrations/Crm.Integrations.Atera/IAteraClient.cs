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

    Task<long> CreateTicketAsync(AteraTicketWrite ticket, CancellationToken cancellationToken);

    Task<long> CreateContactAsync(AteraContactWrite contact, CancellationToken cancellationToken);
}
