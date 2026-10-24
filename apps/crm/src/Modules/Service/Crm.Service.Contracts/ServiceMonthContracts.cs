namespace Crm.Service.Contracts;

/// <summary>The alerts of one source and severity in a period: opened in it, resolved in it, and still open when it ended.</summary>
public sealed record AlertMonthCount(string System, AlertSeverity Severity, int Opened, int Resolved, int OpenAtEnd);

/// <summary>
/// What the Service module saw of one customer in a period (M43, the CRM's monthly summary): its alerts counted per source and
/// severity, and its desk tickets created, resolved and open at the end. Counts only: no title, device or person.
/// </summary>
public sealed record ServiceMonth(IReadOnlyList<AlertMonthCount> Alerts, int TicketsCreated, int TicketsResolved, int TicketsOpenAtEnd);

/// <summary>The Service module's figures of a period for reports (M43).</summary>
public interface IServiceMonthFacts
{
    /// <summary>
    /// The customers whose service the CRM mirrors in the period [<paramref name="from"/>, <paramref name="to"/>): a current device of
    /// any source, or an alert or a desk ticket open at some time in it. The mirrors hold only linked customers' records.
    /// </summary>
    Task<IReadOnlyList<Guid>> GetServicedOrganizationsAsync(DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken);

    /// <summary>One customer's alerts and tickets of the period [<paramref name="from"/>, <paramref name="to"/>).</summary>
    Task<ServiceMonth> GetMonthAsync(Guid organizationId, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken);
}
