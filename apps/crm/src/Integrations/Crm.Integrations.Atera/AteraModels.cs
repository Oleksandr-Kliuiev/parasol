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

/// <summary>
/// An Atera agent. <see cref="SerialNumber"/> (<c>VendorSerialNumber</c>) and <see cref="MacAddresses"/> tell a customer's machines
/// apart (M40); both are as Atera reports them. <see cref="DeviceGuid"/> names the agent in the patch routes and in alerts,
/// <see cref="AppViewUrl"/> is Atera's own link to the device.
/// </summary>
public sealed record AteraAgent(string AgentId, long CustomerId, string MachineName, string? OsType, string? Os, bool Online, DateTimeOffset? LastSeenAt)
{
    public string? SerialNumber { get; init; }

    public IReadOnlyList<string> MacAddresses { get; init; } = [];

    public string? DeviceGuid { get; init; }

    public string? AppViewUrl { get; init; }

    public AteraAgentInventory? Inventory { get; init; }
}

/// <summary>
/// What an agent item of Atera's API v3 says about the computer (M40), field by field as v3 names it. Licence keys
/// (<c>WindowsSerialNumber</c>, <c>OfficeSerialNumber</c>) are left out on purpose. <see cref="Memory"/> and the disks' figures
/// come without units in the API.
/// </summary>
public sealed record AteraAgentInventory(
    string? Vendor,
    string? Model,
    string? Motherboard,
    string? Processor,
    int? ProcessorCores,
    string? ProcessorClock,
    int? Memory,
    string? BiosVersion,
    string? OsVersion,
    string? OsBuild,
    IReadOnlyList<string> IpAddresses,
    string? PublicIp,
    string? DomainName,
    string? LoggedInUsers,
    string? LastLoginUser,
    DateTimeOffset? LastRebootAt,
    IReadOnlyList<AteraDisk> Disks,
    string? AgentVersion);

/// <summary>One disk of an agent (<c>HardwareDisks</c>).</summary>
public sealed record AteraDisk(string? Drive, double? Free, double? Used, double? Total);

/// <summary>
/// One Windows update of an agent: installed (<c>installed-patches</c>, with the time it was installed) or available
/// (<c>available-patches</c>, with Atera's status of it).
/// </summary>
public sealed record AteraPatch(string? KbId, string Name, string? Class, DateTimeOffset? InstalledAt, string? Status);

/// <summary>The updates Atera reports for an agent, and when Atera collected them (<c>timestamp</c>).</summary>
public sealed record AteraPatchList(DateTimeOffset? CollectedAt, IReadOnlyList<AteraPatch> Patches);

/// <summary>
/// An Atera alert. <see cref="AgentId"/> (since 2026) and <see cref="DeviceGuid"/> name the agent it is about exactly; a monitor
/// that is no agent (SNMP, HTTP) has a DeviceGuid no agent carries.
/// </summary>
public sealed record AteraAlert(string AlertId, long? CustomerId, string Title, string Severity, string? DeviceName, DateTimeOffset CreatedAt)
{
    public string? AgentId { get; init; }

    public string? DeviceGuid { get; init; }

    /// <summary>Resolved in Atera: the alert left the open list and sits in its archive (M40).</summary>
    public bool Archived { get; init; }
}

public sealed record AteraTicketWrite(
    string TicketTitle,
    string Description,
    string TicketPriority,
    string TicketImpact,
    string TicketStatus,
    string TicketType,
    long EndUserID);

public sealed record AteraContactWrite(long CustomerID, string Firstname, string Lastname, string? Email, string? Phone);

/// <summary>Who wrote a comment of a ticket: a technician, the customer's end user, or Atera does not say.</summary>
public enum AteraCommentAuthor
{
    Unknown,
    Technician,
    EndUser,
}

/// <summary>One message of a ticket's conversation (M39.2): a reply to or from the customer, or a technician's internal note.</summary>
public sealed record AteraComment(
    string CommentId,
    long TicketId,
    string Text,
    bool IsInternal,
    AteraCommentAuthor Author,
    string? AuthorExternalId,
    string? AuthorName,
    string? AuthorEmail,
    DateTimeOffset CreatedAt);

/// <summary>A comment written as the technician <paramref name="TechnicianId"/>; an internal one stays hidden from the customer.</summary>
public sealed record AteraCommentWrite(string Text, long TechnicianId, bool IsInternal, DateTimeOffset At);

/// <summary>The ticket fields the CRM changes (M39.2); a null field keeps Atera's value.</summary>
public sealed record AteraTicketUpdate(string? Status = null, string? Priority = null, long? TechnicianContactId = null);

/// <summary>Work done on a ticket, recorded in Atera by the CRM (M39.3).</summary>
public sealed record AteraWorkHoursWrite(
    DateTimeOffset Start, DateTimeOffset End, long TechnicianId, string? TechnicianEmail, bool Billable, bool OnSite, string? Comments);

public sealed class AteraApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}
