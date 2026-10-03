using Crm.SharedKernel.Domain;

namespace Crm.Identity.Contracts;

/// <summary>Identity asserted by Entra ID (or the development sign-in).</summary>
public sealed record ExternalIdentity(
    string TenantId,
    string ObjectId,
    string UserPrincipalName,
    string DisplayName,
    string? Email,
    string? Department = null,
    string? JobTitle = null);

public sealed record UserSummary(Guid Id, string DisplayName, string? Email, bool IsActive);

public sealed record UserProfile(Guid Id, string DisplayName, string? Email, string? PreferredLanguage, bool IsActive);

public interface IUserProvisioning
{
    /// <summary>Creates or refreshes the CRM profile on sign-in, keyed by tenant id + object id (never by e-mail).</summary>
    Task<UserProfile> EnsureUserAsync(ExternalIdentity identity, CancellationToken cancellationToken);
}

public interface IUserDirectory
{
    Task<UserProfile?> GetProfileAsync(Guid userId, CancellationToken cancellationToken);

    Task<IReadOnlyDictionary<Guid, UserSummary>> GetUsersAsync(IReadOnlyCollection<Guid> userIds, CancellationToken cancellationToken);
}

/// <summary>A user as reported by the directory (Entra ID via Microsoft Graph delta query).</summary>
public sealed record DirectoryUserChange(
    string TenantId,
    string ObjectId,
    bool Removed,
    bool? AccountEnabled,
    string? DisplayName,
    string? UserPrincipalName,
    string? Email,
    string? Department,
    string? JobTitle);

public sealed record DirectorySyncResult(int Matched, int Updated, int Deactivated, int Reactivated);

public interface IUserDirectorySync
{
    /// <summary>
    /// Applies directory changes to existing CRM users (BR-AUTH-05). Users are only created on sign-in, so changes for people
    /// who never signed in are ignored. Disabled or removed accounts are deactivated.
    /// </summary>
    Task<DirectorySyncResult> ApplyAsync(IReadOnlyCollection<DirectoryUserChange> changes, CancellationToken cancellationToken);
}

public sealed record UserDeactivated(Guid UserId) : DomainEvent;

/// <summary>A technician as an external system (Atera) reports them on tickets and work hours.</summary>
public sealed record TechnicianRef(string System, string ExternalId, string? Email, string? Name);

/// <summary>Maps technicians of external systems to CRM users (BR-TIM-01): automatically by e-mail, otherwise by an administrator.</summary>
public interface ITechnicianDirectory
{
    /// <summary>CRM user per external id, or null when not mapped yet. Unknown technicians are registered so an administrator can map them.</summary>
    Task<IReadOnlyDictionary<string, Guid?>> ResolveAsync(IReadOnlyCollection<TechnicianRef> technicians, CancellationToken cancellationToken);
}

/// <summary>An administrator mapped (or unmapped) an external technician; records imported earlier can be re-assigned.</summary>
public sealed record TechnicianMappingChanged(string System, string ExternalId, Guid? UserId) : DomainEvent;
