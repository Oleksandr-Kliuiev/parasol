using Crm.Identity.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Identity.Domain;

public enum TechnicianMappingMethod
{
    Unmapped,
    Email,
    Manual,
}

public sealed class TechnicianMapping : AuditableEntity
{
    private TechnicianMapping() { }

    public string System { get; private set; } = string.Empty;
    public string ExternalId { get; private set; } = string.Empty;
    public string? Email { get; private set; }
    public string? Name { get; private set; }
    public Guid? UserId { get; private set; }
    public TechnicianMappingMethod Method { get; private set; }

    /// <summary>
    /// The technician everyone without one of their own writes as (one Atera account for the whole firm). It belongs to no one
    /// person, so its tickets, comments and hours map back to nobody.
    /// </summary>
    public bool Shared { get; private set; }

    public DateTimeOffset LastSeenAt { get; private set; }

    public static TechnicianMapping Register(TechnicianRef technician, Guid? userByEmail, DateTimeOffset now) => new()
    {
        System = technician.System,
        ExternalId = technician.ExternalId,
        Email = technician.Email?.Trim().ToLowerInvariant(),
        Name = technician.Name?.Trim(),
        UserId = userByEmail,
        Method = userByEmail is null ? TechnicianMappingMethod.Unmapped : TechnicianMappingMethod.Email,
        LastSeenAt = now,
    };

    public void Seen(TechnicianRef technician, DateTimeOffset now)
    {
        Email = technician.Email?.Trim().ToLowerInvariant() ?? Email;
        Name = technician.Name?.Trim() ?? Name;
        LastSeenAt = now;
    }

    /// <summary>Manual mapping always wins over the e-mail match; mapping to a person, or to no one, ends sharing.</summary>
    public void MapTo(Guid? userId)
    {
        UserId = userId;
        Shared = false;
        Method = userId is null ? TechnicianMappingMethod.Unmapped : TechnicianMappingMethod.Manual;
        Raise(new TechnicianMappingChanged(System, ExternalId, userId));
    }

    /// <summary>A person's decision like a manual mapping, but to no one in particular: imported history keeps its owners.</summary>
    public void ShareWithEveryone()
    {
        UserId = null;
        Shared = true;
        Method = TechnicianMappingMethod.Manual;
        Raise(new TechnicianMappingChanged(System, ExternalId, null));
    }
}
