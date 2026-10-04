using Crm.SharedKernel.Domain;

namespace Crm.Identity.Domain;

public sealed class User : AuditableEntity
{
    private User() { }

    public string TenantId { get; private set; } = string.Empty;
    public string ObjectId { get; private set; } = string.Empty;
    public string UserPrincipalName { get; private set; } = string.Empty;
    public string DisplayName { get; private set; } = string.Empty;
    public string? Email { get; private set; }
    public string? Department { get; private set; }
    public string? JobTitle { get; private set; }
    public bool IsActive { get; private set; }
    public DateTimeOffset? LastLoginAt { get; private set; }
    public string? PreferredLanguage { get; private set; }

    /// <summary>
    /// The CRM roles the authority last confirmed (DEV-10), sorted and comma-separated: the directory sync or a sign-in token.
    /// Sessions take their roles from here on every request, never from the cookie.
    /// </summary>
    public string Roles { get; private set; } = string.Empty;

    /// <summary>Raised whenever the confirmed roles change; a session holding an older version gets the new roles.</summary>
    public int RolesVersion { get; private set; }

    /// <summary>
    /// When the authority last confirmed this user's roles on its own: a sign-in token, or the directory reading that changed
    /// them. A reading that found them unchanged is recorded once for the tenant (<see cref="DirectoryRoleConfirmation"/>), so
    /// the later of the two is what privileged actions check.
    /// </summary>
    public DateTimeOffset? RolesVerifiedAt { get; private set; }

    public IReadOnlyList<string> RoleList => Roles.Length == 0 ? [] : Roles.Split(',');

    public static User Create(string tenantId, string objectId) =>
        new() { TenantId = tenantId, ObjectId = objectId, IsActive = true };

    public void RecordSignIn(string upn, string displayName, string? email, string? department, string? jobTitle, DateTimeOffset at)
    {
        UserPrincipalName = upn;
        DisplayName = displayName;
        Email = email?.ToLowerInvariant();
        Department = department ?? Department;
        JobTitle = jobTitle ?? JobTitle;
        IsActive = true;
        LastLoginAt = at;
    }

    public void SetPreferredLanguage(string? language) => PreferredLanguage = language;

    /// <summary>
    /// Records the roles a sign-in token carried, issued by the authority for this user at <paramref name="verifiedAt"/> (already
    /// limited to CRM roles). A confirmation older than the one held changes nothing. Returns true when the roles changed.
    /// </summary>
    public bool ConfirmRoles(IEnumerable<string> roles, DateTimeOffset verifiedAt)
    {
        if (RolesVerifiedAt is { } held && verifiedAt < held)
        {
            return false;
        }

        RolesVerifiedAt = verifiedAt;
        return SetRoles(roles);
    }

    /// <summary>
    /// Records the roles the directory assigned when it was read at <paramref name="readAt"/>. Unchanged roles leave the user
    /// untouched — the tenant's confirmation says the reading covered everyone — and a reading older than this user's own
    /// confirmation (a sign-in while the directory was being read) changes nothing. Returns true when the roles changed.
    /// </summary>
    public bool ApplyDirectoryRoles(IEnumerable<string> roles, DateTimeOffset readAt)
    {
        if (RolesVerifiedAt is { } held && readAt < held || !SetRoles(roles))
        {
            return false;
        }

        RolesVerifiedAt = readAt;
        return true;
    }

    private bool SetRoles(IEnumerable<string> roles)
    {
        var confirmed = string.Join(',', roles.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal));
        if (confirmed == Roles)
        {
            return false;
        }

        Roles = confirmed;
        RolesVersion++;
        return true;
    }

    public bool Deactivate()
    {
        if (!IsActive)
        {
            return false;
        }

        IsActive = false;
        Raise(new Contracts.UserDeactivated(Id));
        return true;
    }

    public bool Reactivate()
    {
        if (IsActive)
        {
            return false;
        }

        IsActive = true;
        return true;
    }

    /// <summary>Updates profile fields from the directory; returns true when anything changed.</summary>
    public bool ApplyDirectoryProfile(string? displayName, string? upn, string? email, string? department, string? jobTitle)
    {
        var before = (DisplayName, UserPrincipalName, Email, Department, JobTitle);
        DisplayName = string.IsNullOrWhiteSpace(displayName) ? DisplayName : displayName;
        UserPrincipalName = string.IsNullOrWhiteSpace(upn) ? UserPrincipalName : upn;
        Email = string.IsNullOrWhiteSpace(email) ? Email : email.ToLowerInvariant();
        Department = department;
        JobTitle = jobTitle;
        return before != (DisplayName, UserPrincipalName, Email, Department, JobTitle);
    }
}
