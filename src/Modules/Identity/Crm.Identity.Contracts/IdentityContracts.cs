using Crm.SharedKernel.Domain;

namespace Crm.Identity.Contracts;

/// <summary>Identity asserted by Entra ID (or the development sign-in).</summary>
/// <param name="Roles">The CRM roles the sign-in token carries: what Entra assigned at the moment of sign-in (DEV-10).</param>
public sealed record ExternalIdentity(
    string TenantId,
    string ObjectId,
    string UserPrincipalName,
    string DisplayName,
    string? Email,
    string? Department = null,
    string? JobTitle = null,
    IReadOnlyCollection<string>? Roles = null);

public sealed record UserSummary(Guid Id, string DisplayName, string? Email, bool IsActive);

/// <summary>A CRM user; <paramref name="Roles"/> are the roles the directory last confirmed (DEV-10), for decisions made on their behalf.</summary>
public sealed record UserProfile(Guid Id, string DisplayName, string? Email, string? PreferredLanguage, bool IsActive, IReadOnlyList<string>? Roles = null);

public interface IUserProvisioning
{
    /// <summary>Creates or refreshes the CRM profile on sign-in, keyed by tenant id + object id (never by e-mail).</summary>
    Task<UserProfile> EnsureUserAsync(ExternalIdentity identity, CancellationToken cancellationToken);
}

public interface IUserDirectory
{
    Task<UserProfile?> GetProfileAsync(Guid userId, CancellationToken cancellationToken);

    Task<IReadOnlyDictionary<Guid, UserSummary>> GetUsersAsync(IReadOnlyCollection<Guid> userIds, CancellationToken cancellationToken);

    /// <summary>
    /// The CRM user for each e-mail address (the mailbox or the sign-in name, compared without case); the key is the lower-case
    /// address. An address no user has, or that several users share, is left out: the caller must not guess an owner. Inactive
    /// users are returned with <see cref="UserSummary.IsActive"/> false, so the caller can refuse them (DEV-20).
    /// </summary>
    Task<IReadOnlyDictionary<string, UserSummary>> FindByEmailsAsync(IReadOnlyCollection<string> emails, CancellationToken cancellationToken);
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

/// <summary>
/// What a signed-in session may do now (DEV-10): whether the session is still open, the user still active, and the CRM roles
/// the authority — the directory or the last sign-in token — last confirmed, with when.
/// </summary>
public sealed record SessionState(bool SessionOpen, bool IsActive, IReadOnlyList<string> Roles, int RolesVersion, DateTimeOffset? RolesVerifiedAt);

/// <summary>Server-side sessions (DEV-10): the cookie only names one; ending it refuses that cookie on every replica.</summary>
public interface ISessionDirectory
{
    Task<Guid> StartAsync(Guid userId, DateTimeOffset at, CancellationToken cancellationToken);

    Task EndAsync(Guid sessionId, string reason, DateTimeOffset at, CancellationToken cancellationToken);

    Task<SessionState> GetAsync(Guid userId, Guid sessionId, CancellationToken cancellationToken);
}

/// <summary>The CRM app roles of each user as the directory assigns them now — directly or through groups, PIM included (DEV-10).</summary>
public interface IUserRoleDirectory
{
    /// <summary>
    /// Records <paramref name="rolesByObjectId"/>, read from the directory at <paramref name="verifiedAt"/>, as confirmed for every
    /// CRM user of the tenant; a user missing from it has no role. Only users whose roles changed are written. A reading older
    /// than one a user already has (a later sign-in) changes nothing for that user, and one older than the reading applied
    /// last changes nothing at all.
    /// </summary>
    Task<RoleSyncResult> ApplyAsync(
        string tenantId, IReadOnlyDictionary<string, IReadOnlyCollection<string>> rolesByObjectId, DateTimeOffset verifiedAt, CancellationToken cancellationToken);
}

/// <param name="Superseded">A later reading had already been applied, so this one was discarded.</param>
public sealed record RoleSyncResult(int Users, int Changed, bool Superseded = false);
