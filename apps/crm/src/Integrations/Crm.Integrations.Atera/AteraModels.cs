using System.Net;

namespace Crm.Integrations.Atera;

/// <summary>Atera customer, normalized. Stored as the external record payload, so field order and names must stay stable.</summary>
public sealed record AteraCustomer(
    long CustomerId,
    string Name,
    string? BusinessNumber,
    string? Domain,
    string? Address,
    string? City,
    string? ZipCode,
    string? Country,
    string? Phone,
    string? Website,
    DateTimeOffset? LastModified);

public sealed record AteraContact(
    long ContactId,
    long CustomerId,
    string? FirstName,
    string? LastName,
    string? Email,
    string? JobTitle,
    string? Phone,
    string? MobilePhone,
    bool InIgnoreMode,
    DateTimeOffset? LastModified);

public sealed record AteraCustomerWrite(
    string CustomerName,
    string? BusinessNumber,
    string? Domain,
    string? Address,
    string? City,
    string? ZipCode,
    string? Country,
    string? Phone,
    string? Website);

public sealed record AteraTicket(
    long TicketId,
    long? CustomerId,
    long? EndUserId,
    string Title,
    string Status,
    string? Priority,
    string? Impact,
    string? Type,
    string? Source,
    long? TechnicianId,
    string? TechnicianEmail,
    string? TechnicianName,
    string? EndUserName,
    string? EndUserEmail,
    DateTimeOffset CreatedAt,
    DateTimeOffset? FirstResponseAt,
    DateTimeOffset? ResolvedAt,
    DateTimeOffset? LastActivityAt,
    string? Description = null);

public sealed record AteraWorkHours(
    string Id,
    long TicketId,
    string? TechnicianId,
    string? TechnicianEmail,
    string? TechnicianName,
    DateTimeOffset? StartedAt,
    DateTimeOffset? EndedAt,
    decimal Hours,
    bool Billable,
    bool Onsite,
    string? WorkType,
    string? Description);

/// <summary>All work-hour rows of one ticket; <paramref name="Dropped"/> counts rows that could not be used (no id, no or empty duration).</summary>
public sealed record AteraWorkHoursResult(IReadOnlyList<AteraWorkHours> Records, int Dropped);

public sealed record AteraAgent(string AgentId, long CustomerId, string MachineName, string? OsType, string? Os, bool Online, DateTimeOffset? LastSeenAt);

public sealed record AteraAlert(string AlertId, long? CustomerId, string Title, string Severity, string? DeviceName, DateTimeOffset CreatedAt);

public sealed record AteraTicketWrite(
    string TicketTitle,
    string Description,
    string TicketPriority,
    string TicketImpact,
    string TicketStatus,
    string TicketType,
    long EndUserID);

public sealed record AteraContactWrite(long CustomerID, string Firstname, string Lastname, string? Email, string? Phone);

public sealed class AteraApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}
