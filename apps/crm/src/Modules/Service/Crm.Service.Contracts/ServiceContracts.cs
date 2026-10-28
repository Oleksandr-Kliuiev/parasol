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

/// <summary>
/// An agent as read from its source. <paramref name="SerialNumber"/> and <paramref name="MacAddresses"/> are as the source reports
/// them: with the host name they tell one customer's machines apart (M40). <paramref name="AlternateId"/> is the source's second id
/// of the agent (Atera's DeviceGuid, which its patch routes and alerts use); <paramref name="Inventory"/> is what the source says
/// about the computer. <paramref name="Platform"/> is the source's word for the system family (<c>windows</c>, <c>darwin</c>,
/// <c>linux</c>) and <paramref name="Protection"/> what a security source says about the computer's protection (M41); Huntress's
/// <paramref name="AlternateId"/> is the organization the agent reports under, which its actions are allowed for.
/// </summary>
public sealed record ExternalDevice(
    string ExternalId,
    string MachineName,
    DeviceType Type,
    string? Os,
    bool Online,
    DateTimeOffset? LastSeenAt,
    string? Url,
    string? SerialNumber = null,
    IReadOnlyList<string>? MacAddresses = null,
    string? AlternateId = null,
    DeviceInventoryReading? Inventory = null,
    string? Platform = null,
    DeviceProtectionReading? Protection = null);

/// <summary>
/// What a security source says about a computer's protection (M41, Huntress): Microsoft Defender's status, sub-status and policy
/// as the source words them, when the source last heard them from the computer, and whether the computer is cut off from the
/// network (<c>Isolated</c>, <c>Pending Isolation</c>, <c>Pending Release</c>; <c>Disabled</c> when it is not).
/// </summary>
public sealed record DeviceProtectionReading(
    string? AntivirusStatus,
    string? AntivirusSubstatus,
    string? AntivirusPolicyStatus,
    DateTimeOffset? AntivirusReportedAt,
    string? Isolation);

/// <summary>
/// What a source says about the computer an agent runs on (M40): hardware, system, network, who is logged in and the last
/// restart, as the source reports them. <paramref name="Memory"/> and the disks' figures carry no unit in Atera's API.
/// </summary>
public sealed record DeviceInventoryReading(
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
    IReadOnlyList<DeviceDisk> Disks,
    string? AgentVersion);

/// <summary>One disk of a computer as its source reports it.</summary>
public sealed record DeviceDisk(string? Drive, double? Free, double? Used, double? Total);

/// <summary>
/// A current device of a source, for a read that asks the source about each device (M40: its Windows updates) and for an action at
/// it (M41: <paramref name="Isolation"/> says whether the computer is isolated now).
/// </summary>
public sealed record DeviceRef(Guid Id, Guid OrganizationId, string ExternalId, string? AlternateId, string MachineName, string? Os, string? Isolation = null);

/// <summary>One Windows update of a device: installed (with the time) or available (with the source's status of it).</summary>
public sealed record DevicePatchReading(string? KbId, string Name, string? Class, DateTimeOffset? InstalledAt, string? Status);

/// <summary>
/// One complete read of a device's Windows updates (M40). <paramref name="CollectedAt"/> is when the source collected them, which
/// may be long before the read.
/// </summary>
public sealed record DevicePatchSnapshot(IReadOnlyList<DevicePatchReading> Installed, IReadOnlyList<DevicePatchReading> Available, DateTimeOffset? CollectedAt);

/// <summary>Who wrote a comment of a ticket: a technician, the customer's end user, or the service desk does not say.</summary>
public enum TicketCommentAuthor
{
    Unknown,
    Technician,
    EndUser,
}

/// <summary>
/// One message of a ticket's conversation as read from the service desk (M39.2), with the CRM user of a technician resolved.
/// <paramref name="ExternalId"/> is the desk's own id: the same comment read again updates its row.
/// </summary>
public sealed record ExternalTicketComment(
    string ExternalId, string Text, bool IsInternal, TicketCommentAuthor Author, string? AuthorName, Guid? TechnicianUserId, DateTimeOffset CreatedAt);

/// <summary>What applying one complete read of a ticket's conversation changed; <c>Applied</c> is false when the CRM has no such ticket.</summary>
public sealed record TicketConversationResult(bool Applied, int Added, int Updated, int Removed)
{
    public int Changed => Added + Updated + Removed;
}

/// <summary>
/// A stored ticket as an integration's action sees it (M39.2): the preview starts from it, the worker compares it with the live
/// ticket. <paramref name="OwnerCustomerId"/> is the desk's customer the ticket was read under.
/// </summary>
public sealed record TicketView(
    Guid Id,
    string System,
    long ExternalId,
    Guid OrganizationId,
    string Title,
    string Status,
    bool IsOpen,
    string? Priority,
    Guid? TechnicianUserId,
    string? TechnicianName,
    string? EndUserName,
    string? EndUserEmail,
    long? OwnerCustomerId,
    string? Url);

/// <summary>A stored ticket in short; <paramref name="Url"/> leads to it at the desk when the integration has a configured link.</summary>
public sealed record TicketRef(Guid Id, string System, long ExternalId, Guid OrganizationId, string Title, string Status, string? Url);

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

    /// <summary>The devices of a source that are reported now, oldest first (M40).</summary>
    Task<IReadOnlyList<DeviceRef>> GetCurrentDevicesAsync(string system, CancellationToken cancellationToken);

    /// <summary>A current device of a source by the source's id of it (M41: the target of an action); null when there is none.</summary>
    Task<DeviceRef?> GetDeviceAsync(string system, string externalId, CancellationToken cancellationToken);

    /// <summary>
    /// Stores one complete read of a device's Windows updates in place of the last one (M40). False when the CRM has no such current
    /// device (it was removed in between).
    /// </summary>
    Task<bool> ApplyDevicePatchesAsync(Guid deviceId, DevicePatchSnapshot snapshot, CancellationToken cancellationToken);

    /// <summary>
    /// Applies one read of a source's open alerts (M38): listed alerts are kept open under the id they already have, a stored
    /// open alert that a complete read no longer lists is resolved, and an incomplete read changes nothing.
    /// </summary>
    Task<AlertSnapshotResult> ApplyAlertSnapshotAsync(AlertSnapshot snapshot, CancellationToken cancellationToken);

    /// <summary>
    /// A read of one alert at its source says it is no longer open (M40: resolved there, or deleted, after an action asked for it):
    /// the stored alert is resolved as a complete read would resolve it. False when no such alert is open in the CRM.
    /// </summary>
    Task<bool> ResolveAlertAsync(string system, string externalId, CancellationToken cancellationToken);

    /// <summary>
    /// One device as its source has it now (M41: the read after an action changed it), the customer's other devices as they are. The
    /// device keeps its machine. False when the CRM has no current device of the source with that id for the customer.
    /// </summary>
    Task<bool> ApplyDeviceAsync(Guid organizationId, string system, ExternalDevice device, CancellationToken cancellationToken);

    /// <summary>
    /// The source no longer has the device (M41: its agent was uninstalled from the CRM): it is marked removed and its machine matched
    /// again, as a complete read would. False when no such device is current.
    /// </summary>
    Task<bool> RemoveDeviceAsync(string system, string externalId, CancellationToken cancellationToken);

    /// <summary>A stored alert by its CRM id, in any state; null when there is none.</summary>
    Task<AlertRef?> GetAlertAsync(Guid alertId, CancellationToken cancellationToken);

    /// <summary>A stored alert by its source's own id (a task's receipt names it so), in any state; null when there is none.</summary>
    Task<AlertRef?> GetAlertAsync(string system, string externalId, CancellationToken cancellationToken);

    /// <summary>The stored alerts among <paramref name="alertIds"/>, keyed by id; ids without an alert are left out.</summary>
    Task<IReadOnlyDictionary<Guid, AlertRef>> GetAlertsAsync(IReadOnlyCollection<Guid> alertIds, CancellationToken cancellationToken);

    /// <summary>
    /// The stored alerts of a source among <paramref name="externalIds"/> (the source's own ids), in any state, keyed by that id; ids
    /// without an alert are left out. One read for a batch of actions (M45), not one per alert.
    /// </summary>
    Task<IReadOnlyDictionary<string, AlertRef>> GetAlertsAsync(string system, IReadOnlyCollection<string> externalIds, CancellationToken cancellationToken);

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

    /// <summary>A stored ticket by the desk's id, open or not; null when the CRM has none (M39.2).</summary>
    Task<TicketView?> GetTicketAsync(string system, long externalId, CancellationToken cancellationToken);

    /// <summary>
    /// Applies one complete read of a ticket's conversation (M39.2): listed comments are added or updated, comments the read no
    /// longer lists are removed, and the ticket remembers when its conversation was read. With <paramref name="withheld"/> the
    /// person the ticket is about asked to be forgotten (DEV-11): comments are kept without their text and author.
    /// </summary>
    Task<TicketConversationResult> ApplyTicketConversationAsync(
        string system, long ticketExternalId, IReadOnlyCollection<ExternalTicketComment> comments, bool withheld, CancellationToken cancellationToken);

    /// <summary>
    /// Open tickets whose conversation was read before <paramref name="readBefore"/> or never, the longest waiting first, at most
    /// <paramref name="limit"/>: what a conversation read looks at when the desk's list of changes may have missed a comment.
    /// </summary>
    Task<IReadOnlyList<TicketRef>> GetStaleConversationsAsync(string system, DateTimeOffset readBefore, int limit, CancellationToken cancellationToken);

    /// <summary>
    /// The tickets a person is the end user of (DEV-11, M39): their contact, or one of their addresses. A subject request uses it to
    /// find what other modules keep about those tickets, such as the texts of the actions asked for them.
    /// </summary>
    Task<IReadOnlyList<TicketRef>> GetTicketsOfPersonAsync(Guid? contactId, IReadOnlyCollection<string> emails, CancellationToken cancellationToken);
}

/// <summary>A user asked for a ticket to be created in the service desk.</summary>
public sealed record TicketRequested(Guid RequestId, Guid OrganizationId) : DomainEvent;

/// <summary>Device counts of one organization; <paramref name="SnapshotDate"/> is null when no snapshot exists and the live list was counted.</summary>
public sealed record DeviceCountReading(IReadOnlyDictionary<DeviceType, int> Counts, DateOnly? SnapshotDate);
