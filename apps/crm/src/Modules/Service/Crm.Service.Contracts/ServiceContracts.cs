using Crm.SharedKernel.Domain;

namespace Crm.Service.Contracts;

public enum DeviceType
{
    Workstation,
    Server,
    Network,
    Other,
}

public enum AlertSeverity
{
    Critical,
    Warning,
}

public enum TicketRequestStatus
{
    Pending,
    Created,
    Failed,
}

/// <summary>A ticket as read from the service desk (Atera), with CRM references already resolved.</summary>
public sealed record ExternalTicket(
    string System,
    long ExternalId,
    Guid OrganizationId,
    Guid? ContactId,
    string Title,
    string Status,
    string? Priority,
    string? Impact,
    string? Type,
    string? Source,
    Guid? TechnicianUserId,
    string? TechnicianName,
    string? EndUserName,
    string? EndUserEmail,
    DateTimeOffset CreatedAt,
    DateTimeOffset? FirstResponseAt,
    DateTimeOffset? ResolvedAt,
    DateTimeOffset? LastActivityAt,
    string? Url,
    long? OwnerCustomerId = null,
    Guid? OwnerLinkId = null);

public sealed record ExternalDevice(string ExternalId, string MachineName, DeviceType Type, string? Os, bool Online, DateTimeOffset? LastSeenAt, string? Url);

public sealed record TicketRef(Guid Id, string System, long ExternalId, Guid OrganizationId, string Title, string Status);

public sealed record TicketRequestView(
    Guid Id, Guid OrganizationId, Guid? ContactId, string Title, string Description, string Priority, string Type, TicketRequestStatus Status, Guid? RequestedBy);

/// <summary>Service load across all customers, for the dashboard (FR-RPT-01). Alerts count while they are open.</summary>
public sealed record ServiceLoad(int OpenTickets, int UnassignedTickets, int CriticalAlerts, int WarningAlerts, int Devices, int DevicesOffline);

/// <summary>Public API of the Service module: the mirror is written by integrations and read by billing and time tracking.</summary>
public interface IServiceApi
{
    /// <summary>Inserts or updates tickets; returns how many changed.</summary>
    Task<int> UpsertTicketsAsync(IReadOnlyCollection<ExternalTicket> tickets, CancellationToken cancellationToken);

    /// <summary>Makes the organization's device list equal to <paramref name="devices"/>; devices no longer reported are marked removed.</summary>
    Task ReplaceDevicesAsync(Guid organizationId, string system, IReadOnlyCollection<ExternalDevice> devices, CancellationToken cancellationToken);

    /// <summary>
    /// Applies one read of a source's open alerts (M38): listed alerts are kept open under the id they already have, a stored
    /// open alert that a complete read no longer lists is resolved, and an incomplete read changes nothing.
    /// </summary>
    Task<AlertSnapshotResult> ApplyAlertSnapshotAsync(AlertSnapshot snapshot, CancellationToken cancellationToken);

    /// <summary>A stored alert by its CRM id, in any state; null when there is none.</summary>
    Task<AlertRef?> GetAlertAsync(Guid alertId, CancellationToken cancellationToken);

    /// <summary>The stored alerts among <paramref name="alertIds"/>, keyed by id; ids without an alert are left out.</summary>
    Task<IReadOnlyDictionary<Guid, AlertRef>> GetAlertsAsync(IReadOnlyCollection<Guid> alertIds, CancellationToken cancellationToken);

    /// <summary>Stores today's device count per organization and type (BR-SRV-03); safe to repeat on the same day.</summary>
    Task<int> TakeDeviceSnapshotAsync(DateOnly date, CancellationToken cancellationToken);

    /// <summary>Device counts on a date: the snapshot of that day or the latest before it (BR-CON-01).</summary>
    Task<IReadOnlyDictionary<DeviceType, int>> GetDeviceCountsAsync(Guid organizationId, DateOnly date, CancellationToken cancellationToken);

    /// <summary>The same dated counts for a billing batch; each customer uses its own latest snapshot, or its live devices when none exists.</summary>
    Task<IReadOnlyDictionary<Guid, IReadOnlyDictionary<DeviceType, int>>> GetDeviceCountsAsync(
        IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken);

    /// <summary>
    /// The same counts with their age (billing needs to know when a quantity was last read): the day of the snapshot used, or
    /// <c>null</c> when the customer has no snapshot and the live device list answered instead.
    /// </summary>
    Task<IReadOnlyDictionary<Guid, DeviceCountReading>> GetDeviceCountReadingsAsync(
        IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken);

    /// <summary>External ids of tickets that may still get work hours: open, or created or resolved since <paramref name="since"/>.</summary>
    Task<IReadOnlyList<TicketRef>> GetActiveTicketsAsync(string system, DateTimeOffset since, CancellationToken cancellationToken);

    Task<IReadOnlyDictionary<long, TicketRef>> GetTicketsAsync(string system, IReadOnlyCollection<long> externalIds, CancellationToken cancellationToken);

    Task<TicketRequestView?> GetTicketRequestAsync(Guid requestId, CancellationToken cancellationToken);

    /// <summary>Open tickets, alerts and devices across all customers.</summary>
    Task<ServiceLoad> GetLoadAsync(CancellationToken cancellationToken);

    Task CompleteTicketRequestAsync(Guid requestId, long externalTicketId, string? url, CancellationToken cancellationToken);

    Task FailTicketRequestAsync(Guid requestId, string message, CancellationToken cancellationToken);
}

/// <summary>A user asked for a ticket to be created in the service desk.</summary>
public sealed record TicketRequested(Guid RequestId, Guid OrganizationId) : DomainEvent;

/// <summary>Device counts of one organization; <paramref name="SnapshotDate"/> is null when no snapshot exists and the live list was counted.</summary>
public sealed record DeviceCountReading(IReadOnlyDictionary<DeviceType, int> Counts, DateOnly? SnapshotDate);
