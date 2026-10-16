using System.Security.Cryptography;
using System.Text;
using Crm.Privacy.Contracts;
using Crm.Privacy.Domain;
using Crm.Privacy.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Privacy.Features;

/// <summary>
/// Turns an e-mail address into the value a suppression keeps: HMAC-SHA256 under the installation's key (created by the
/// migration, never shown), of the trimmed lower-case address. Not reversible; it can only confirm an address someone
/// already has — and only with access to the key.
/// </summary>
internal sealed class SuppressionHasher(PrivacyDbContext db)
{
    private byte[]? _key;

    public async Task<string> HashEmailAsync(string email, CancellationToken cancellationToken) => Hash(await KeyAsync(cancellationToken), email);

    public async Task<byte[]> KeyAsync(CancellationToken cancellationToken) =>
        _key ??= await db.Keys.AsNoTracking()
            .Where(k => k.Name == PrivacyDbContext.SuppressionKeyName).Select(k => k.Value).SingleAsync(cancellationToken);

    /// <summary>
    /// The installation a deletion manifest belongs to (DEV-11-AC06): derived from this database's key, which a restore brings
    /// back with the database and a new database does not share. It identifies, and reveals nothing about the key.
    /// </summary>
    public async Task<string> InstallationAsync(CancellationToken cancellationToken) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(await KeyAsync(cancellationToken), "crm-privacy-installation"u8))[..16];

    public static string Hash(byte[] key, string email) =>
        Convert.ToHexStringLower(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(Normalize(email))));

    public static string Normalize(string email) => email.Trim().ToLowerInvariant();
}

internal sealed class SuppressionList(PrivacyDbContext db, SuppressionHasher hasher) : ISuppressionList
{
    public async Task<bool> IsSuppressedAsync(string? email, ExternalReference? reference, CancellationToken cancellationToken)
    {
        var values = new List<(SuppressionKind Kind, string Value)>();
        if (!string.IsNullOrWhiteSpace(email))
        {
            values.Add((SuppressionKind.Email, await hasher.HashEmailAsync(email, cancellationToken)));
        }

        if (reference is not null)
        {
            values.Add((SuppressionKind.ExternalReference, reference.ToString()));
        }

        foreach (var (kind, value) in values)
        {
            if (await db.Suppressions.AsNoTracking().AnyAsync(s => s.Kind == kind && s.Value == value && s.LiftedAt == null, cancellationToken))
            {
                return true;
            }
        }

        return false;
    }

    public async Task<ISuppressionCheck> SnapshotAsync(CancellationToken cancellationToken)
    {
        var live = await db.Suppressions.AsNoTracking().Where(s => s.LiftedAt == null).Select(s => new { s.Kind, s.Value }).ToListAsync(cancellationToken);
        return new Snapshot(
            await hasher.KeyAsync(cancellationToken),
            live.Where(s => s.Kind == SuppressionKind.Email).Select(s => s.Value).ToHashSet(StringComparer.Ordinal),
            live.Where(s => s.Kind == SuppressionKind.ExternalReference).Select(s => s.Value).ToHashSet(StringComparer.Ordinal));
    }

    private sealed class Snapshot(byte[] key, HashSet<string> emails, HashSet<string> references) : ISuppressionCheck
    {
        public bool IsSuppressed(string? email, ExternalReference? reference) =>
            (reference is not null && references.Contains(reference.ToString())) ||
            (!string.IsNullOrWhiteSpace(email) && emails.Count > 0 && emails.Contains(SuppressionHasher.Hash(key, email)));
    }
}

internal sealed class ErasedRecords(PrivacyDbContext db) : IErasedRecords
{
    public async Task<IReadOnlySet<Guid>> ErasedAsync(string module, string entityType, IReadOnlyCollection<Guid> entityIds, CancellationToken cancellationToken)
    {
        if (entityIds.Count == 0)
        {
            return new HashSet<Guid>();
        }

        var erased = new HashSet<Guid>();
        foreach (var chunk in entityIds.Distinct().Chunk(500))
        {
            erased.UnionWith(await db.ErasedRecords.AsNoTracking()
                .Where(r => r.Module == module && r.EntityType == entityType && chunk.Contains(r.EntityId))
                .Select(r => r.EntityId)
                .ToListAsync(cancellationToken));
        }

        return erased;
    }
}
