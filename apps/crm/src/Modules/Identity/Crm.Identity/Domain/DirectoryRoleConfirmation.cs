namespace Crm.Identity.Domain;

/// <summary>
/// The moment the directory was last read for a tenant and its role assignments applied to every CRM user of that tenant
/// (DEV-10). One row per tenant instead of a write per user every two minutes: users are changed — and audited — only when
/// their roles change, and a session's roles count as confirmed at the later of this and the user's own confirmation.
/// </summary>
public sealed class DirectoryRoleConfirmation
{
    private DirectoryRoleConfirmation() { }

    public string TenantId { get; private set; } = string.Empty;

    /// <summary>When the applied reading began; it only moves forward. Also the concurrency token of overlapping runs.</summary>
    public DateTimeOffset ConfirmedAt { get; private set; }

    public static DirectoryRoleConfirmation For(string tenantId, DateTimeOffset readAt) => new() { TenantId = tenantId, ConfirmedAt = readAt };

    /// <summary>
    /// False for a reading older than the one applied last (an overlapping run that began earlier); otherwise records it.
    /// </summary>
    public bool Advance(DateTimeOffset readAt)
    {
        if (readAt < ConfirmedAt)
        {
            return false;
        }

        ConfirmedAt = readAt;
        return true;
    }
}
