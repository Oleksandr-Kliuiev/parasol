using Crm.Service.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Service.Domain;

/// <summary>Mirror of a service desk ticket. Not audited: the service desk is the system of record.</summary>
public sealed class Ticket : Entity
{
    private static readonly string[] ClosedStatuses = ["Resolved", "Closed"];

    private Ticket() { }

    public string System { get; private set; } = string.Empty;
    public long ExternalId { get; private set; }
    public Guid OrganizationId { get; private set; }
    public Guid? ContactId { get; private set; }
    public string Title { get; private set; } = string.Empty;
    public string Status { get; private set; } = string.Empty;
    public bool IsOpen { get; private set; }
    public string? Priority { get; private set; }
    public string? Impact { get; private set; }
    public string? Type { get; private set; }
    public string? Source { get; private set; }
    public Guid? TechnicianUserId { get; private set; }
    public string? TechnicianName { get; private set; }
    public string? EndUserName { get; private set; }
    public string? EndUserEmail { get; private set; }
    public DateTimeOffset CreatedAtSource { get; private set; }
    public DateTimeOffset? FirstResponseAt { get; private set; }
    public DateTimeOffset? ResolvedAt { get; private set; }
    public DateTimeOffset? LastActivityAt { get; private set; }
    public string? Url { get; private set; }
    public DateTimeOffset SyncedAt { get; private set; }

    public long? OwnerCustomerId { get; private set; }
    public Guid? OwnerLinkId { get; private set; }
    /// <summary>Local time the last payload was accepted. Never a provider observation or successful sync claim.</summary>
    public DateTimeOffset? ImportedAt { get; private set; }

    public static Ticket From(ExternalTicket source, DateTimeOffset now)
    {
        var ticket = new Ticket { System = source.System, ExternalId = source.ExternalId };
        ticket.Apply(source, now);
        return ticket;
    }

    /// <summary>Returns true when a visible field or exact owner proof changed. Import time alone is not a change.</summary>
    public bool Apply(ExternalTicket s, DateTimeOffset now)
    {
        var before = Signature();
        OrganizationId = s.OrganizationId;
        OwnerCustomerId = s.OwnerCustomerId;
        OwnerLinkId = s.OwnerLinkId;
        ImportedAt = now;
        ContactId = s.ContactId;
        Title = s.Title.Length > 512 ? s.Title[..512] : s.Title;
        Status = s.Status;
        IsOpen = !ClosedStatuses.Contains(s.Status, StringComparer.OrdinalIgnoreCase);
        Priority = s.Priority;
        Impact = s.Impact;
        Type = s.Type;
        Source = s.Source;
        TechnicianUserId = s.TechnicianUserId;
        TechnicianName = s.TechnicianName;
        EndUserName = s.EndUserName;
        EndUserEmail = s.EndUserEmail;
        CreatedAtSource = s.CreatedAt;
        FirstResponseAt = s.FirstResponseAt;
        ResolvedAt = s.ResolvedAt;
        LastActivityAt = s.LastActivityAt;
        Url = s.Url;
        var changed = before != Signature();
        if (changed)
        {
            SyncedAt = now;
        }

        return changed;
    }

    /// <summary>
    /// Forgets the end user of a ticket (DEV-11): name, address and contact link. The ticket itself is Atera's and stays for
    /// the SLA figures; the next synchronization leaves the person out as long as their suppression lasts.
    /// </summary>
    public bool ForgetEndUser()
    {
        if (EndUserName is null && EndUserEmail is null && ContactId is null)
        {
            return false;
        }

        EndUserName = null;
        EndUserEmail = null;
        ContactId = null;
        return true;
    }

    private string Signature() => string.Join('|', OwnerCustomerId, OwnerLinkId, OrganizationId, ContactId, Title, Status, Priority, Impact, Type, Source, TechnicianUserId, TechnicianName,
        EndUserName, EndUserEmail, CreatedAtSource.ToUnixTimeSeconds(), FirstResponseAt?.ToUnixTimeSeconds(), ResolvedAt?.ToUnixTimeSeconds(), LastActivityAt?.ToUnixTimeSeconds(), Url);
}

public sealed class Device : Entity
{
    private Device() { }

    public string System { get; private set; } = string.Empty;
    public string ExternalId { get; private set; } = string.Empty;
    public Guid OrganizationId { get; private set; }
    public string MachineName { get; private set; } = string.Empty;
    public DeviceType Type { get; private set; }
    public string? Os { get; private set; }
    public bool Online { get; private set; }
    public DateTimeOffset? LastSeenAt { get; private set; }
    public string? Url { get; private set; }
    public DateTimeOffset FirstSeenAt { get; private set; }

    /// <summary>Set when the device is no longer reported; it stops counting from then on.</summary>
    public DateTimeOffset? RemovedAt { get; private set; }

    public static Device From(string system, Guid organizationId, ExternalDevice source, DateTimeOffset now)
    {
        var device = new Device { System = system, ExternalId = source.ExternalId, FirstSeenAt = now };
        device.Apply(organizationId, source);
        return device;
    }

    public void Apply(Guid organizationId, ExternalDevice s)
    {
        OrganizationId = organizationId;
        MachineName = s.MachineName;
        Type = s.Type;
        Os = s.Os;
        Online = s.Online;
        LastSeenAt = s.LastSeenAt;
        Url = s.Url;
        RemovedAt = null;
    }

    public void MarkRemoved(DateTimeOffset now) => RemovedAt ??= now;
}

public sealed class DeviceCountSnapshot : Entity
{
    private DeviceCountSnapshot() { }

    public DeviceCountSnapshot(Guid organizationId, DateOnly date, DeviceType type, int count)
    {
        OrganizationId = organizationId;
        Date = date;
        Type = type;
        Count = count;
    }

    public Guid OrganizationId { get; private set; }
    public DateOnly Date { get; private set; }
    public DeviceType Type { get; private set; }
    public int Count { get; set; }
}

public sealed class Alert : Entity
{
    private Alert() { }

    public Alert(string system, Guid organizationId, ExternalAlert source)
    {
        System = system;
        OrganizationId = organizationId;
        ExternalId = source.ExternalId;
        Severity = source.Severity;
        Title = source.Title.Length > 512 ? source.Title[..512] : source.Title;
        DeviceName = source.DeviceName;
        CreatedAtSource = source.CreatedAt;
    }

    public string System { get; private set; } = string.Empty;
    public string ExternalId { get; private set; } = string.Empty;
    public Guid OrganizationId { get; private set; }
    public AlertSeverity Severity { get; private set; }
    public string Title { get; private set; } = string.Empty;
    public string? DeviceName { get; private set; }
    public DateTimeOffset CreatedAtSource { get; private set; }
}

/// <summary>A ticket a CRM user asked to create in the service desk (BR-SRV-02). Audited, as it is a user action.</summary>
public sealed class TicketRequest : AuditableEntity, IErasable
{
    private TicketRequest() { }

    public Guid OrganizationId { get; private set; }
    public Guid? ContactId { get; private set; }
    public string Title { get; private set; } = string.Empty;
    public string Description { get; private set; } = string.Empty;
    public string Priority { get; private set; } = string.Empty;
    public string Type { get; private set; } = string.Empty;
    public TicketRequestStatus Status { get; private set; }
    public long? ExternalTicketId { get; private set; }
    public string? Url { get; private set; }
    public string? Error { get; private set; }

    /// <inheritdoc />
    public string? ErasureReference { get; private set; }

    /// <summary>Clears a ticket request made for an erased person (DEV-11): what was written about them and the link to them.</summary>
    public bool Erase(string reference)
    {
        const string erased = "—";
        if (Title == erased && Description == erased && Error is null && ContactId is null)
        {
            return false;
        }

        ErasureReference = reference;
        Title = erased;
        Description = erased;
        Error = null;
        ContactId = null;
        return true;
    }

    public static TicketRequest Create(Guid organizationId, Guid? contactId, string title, string description, string priority, string type)
    {
        var request = new TicketRequest
        {
            OrganizationId = organizationId,
            ContactId = contactId,
            Title = title.Trim(),
            Description = description.Trim(),
            Priority = priority,
            Type = type,
            Status = TicketRequestStatus.Pending,
        };
        request.Raise(new TicketRequested(request.Id, organizationId));
        return request;
    }

    public void Complete(long externalTicketId, string? url)
    {
        Status = TicketRequestStatus.Created;
        ExternalTicketId = externalTicketId;
        Url = url;
        Error = null;
    }

    public void Fail(string message)
    {
        if (Status != TicketRequestStatus.Created)
        {
            Status = TicketRequestStatus.Failed;
            Error = message.Length > 1000 ? message[..1000] : message;
        }
    }
}
