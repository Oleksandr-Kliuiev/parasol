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
