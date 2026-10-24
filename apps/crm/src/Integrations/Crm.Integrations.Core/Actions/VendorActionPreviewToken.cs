using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace Crm.Integrations.Core.Actions;

/// <summary>What a preview token vouches for: this person saw this exact action at this level, until <paramref name="ExpiresAt"/>.</summary>
public sealed record VendorActionPreviewClaim(Guid UserId, string Fingerprint, VendorActionLevel Level, DateTimeOffset ExpiresAt);

/// <summary>
/// The signed <c>previewToken</c> (M39.1): issued with a preview, required by the command. It is protected with the CRM's Data
/// Protection keys (shared by the crm-web replicas), so the browser can carry it but cannot change it, and it binds the person,
/// the exact target and parameters and the level for ten minutes — an action is only sent the way it was shown.
/// </summary>
public static class VendorActionPreviewToken
{
    public const string Purpose = "Crm.VendorActions.Preview.v1";

    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    public static string Issue(IDataProtectionProvider protection, VendorActionPreviewClaim claim) =>
        protection.CreateProtector(Purpose).Protect(JsonSerializer.Serialize(claim));

    /// <summary>The claim of a token this CRM issued, or null for anything else (changed, foreign, not a token).</summary>
    public static VendorActionPreviewClaim? Read(IDataProtectionProvider protection, string? token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<VendorActionPreviewClaim>(protection.CreateProtector(Purpose).Unprotect(token));
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException or FormatException)
        {
            return null;
        }
    }
}
