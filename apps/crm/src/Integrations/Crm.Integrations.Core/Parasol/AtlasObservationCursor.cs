using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Continuation contains no browser-readable Atlas key and is valid for one employee, link and selection.</summary>
public sealed class AtlasObservationCursor(IDataProtectionProvider protection, TimeProvider time)
{
    private readonly IDataProtector _protector = protection.CreateProtector("Parasol.Atlas.ObservationQueue.v1");
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);
    internal static bool IsAtlasCursor(string? value) => value is not null
        && Regex.IsMatch(value, @"\A[A-Za-z0-9_-]{1,400}\z", RegexOptions.CultureInvariant);

    internal string Protect(Guid employeeId, CustomerIdentityView identity, AtlasObservationSelection selection, string atlasCursor)
    {
        if (identity.Atlas is null || identity.LinkId is null || !IsAtlasCursor(atlasCursor)) throw new InvalidOperationException();
        var issuedAt = time.GetUtcNow();
        return _protector.Protect(JsonSerializer.Serialize(new Continuation(employeeId, identity.CustomerId, identity.LinkId.Value,
            identity.Atlas.WorkspaceId, identity.Atlas.ClientId, selection.Severity, selection.Status, atlasCursor, issuedAt, issuedAt + Lifetime)));
    }

    internal bool TryRead(string value, Guid employeeId, CustomerIdentityView identity, AtlasObservationSelection selection, out string? atlasCursor)
        => TryRead(value, employeeId, identity, selection, out atlasCursor, out _);

    internal bool TryRead(string value, Guid employeeId, CustomerIdentityView identity, AtlasObservationSelection selection,
        out string? atlasCursor, out bool identityChanged)
    {
        atlasCursor = null;
        identityChanged = false;
        if (value.Length is < 1 or > 2048 || identity.Atlas is null || identity.LinkId is null) return false;
        try
        {
            var continuation = JsonSerializer.Deserialize<Continuation>(_protector.Unprotect(value));
            var now = time.GetUtcNow();
            if (continuation is null || continuation.EmployeeId != employeeId || continuation.CustomerId != identity.CustomerId
                || continuation.Severity != selection.Severity
                || continuation.Status != selection.Status || continuation.IssuedAt > now || continuation.ExpiresAt <= now
                || continuation.ExpiresAt - continuation.IssuedAt != Lifetime || !IsAtlasCursor(continuation.AtlasCursor)) return false;
            // Only an authenticated, current token for this employee/customer/selection can establish that the parent identity changed.
            if (continuation.LinkId != identity.LinkId || continuation.WorkspaceId != identity.Atlas.WorkspaceId
                || continuation.ClientId != identity.Atlas.ClientId)
            {
                identityChanged = true;
                return false;
            }
            atlasCursor = continuation.AtlasCursor;
            return true;
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException or FormatException or ArgumentException) { return false; }
    }

    private sealed record Continuation(Guid EmployeeId, Guid CustomerId, Guid LinkId, string WorkspaceId, string ClientId,
        AtlasQueueSeverity Severity, AtlasQueueStatus Status, string AtlasCursor, DateTimeOffset IssuedAt, DateTimeOffset ExpiresAt);
}
