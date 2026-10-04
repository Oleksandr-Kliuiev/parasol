using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Crm.Integrations.Core.Persistence;
using Crm.Privacy.Contracts;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core;

/// <summary>What an adapter knows about one external record after mapping it from the external API model.</summary>
public sealed record ExternalRecordInput(
    string System,
    string ExternalType,
    string ExternalId,
    string DisplayName,
    object Payload,
    DateTimeOffset? ExternalChangedAt = null,
    string? OrgNumber = null,
    string? Email = null,
    string? Phone = null,
    string? Domain = null,
    string? ParentExternalId = null,
    bool IsGone = false,
    bool IsPerson = false);

public sealed record UpsertOutcome(ExternalRecord Record, bool IsNew, bool Changed);

public sealed class ExternalRecordStore(IntegrationDbContext db, TimeProvider timeProvider, ISuppressionList suppressions)
{
    /// <summary>What a mirrored person record keeps once they are erased or suppressed (DEV-11): the key, nothing about them.</summary>
    public const string RedactedPayload = "{}";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly string RedactedHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(RedactedPayload)));
    private ISuppressionCheck? _suppressed;

    /// <summary>
    /// Stores the latest payload; <see cref="UpsertOutcome.Changed"/> is true only when the content hash differs. A person
    /// erased at their request (DEV-11-AC05) is kept as a bare key: no name, address or payload, never "changed" — so no run
    /// links, imports or shows them again until their suppression is lifted with a new lawful basis.
    /// </summary>
    public async Task<UpsertOutcome> UpsertAsync(ExternalRecordInput input, CancellationToken cancellationToken)
    {
        if (input.IsPerson)
        {
            _suppressed ??= await suppressions.SnapshotAsync(cancellationToken);
            if (_suppressed.IsSuppressed(input.Email, new ExternalReference(input.System, input.ExternalType, input.ExternalId)))
            {
                return await KeepRedactedAsync(input, cancellationToken);
            }
        }

        var payload = JsonSerializer.Serialize(input.Payload, input.Payload.GetType(), JsonOptions);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload)));
        var now = timeProvider.GetUtcNow();

        var record = await db.ExternalRecords.SingleOrDefaultAsync(
            r => r.System == input.System && r.ExternalType == input.ExternalType && r.ExternalId == input.ExternalId, cancellationToken);
        var isNew = record is null;
        if (record is null)
        {
            record = new ExternalRecord
            {
                Id = SequentialId.New(now),
                System = input.System,
                ExternalType = input.ExternalType,
                ExternalId = input.ExternalId,
                DisplayName = input.DisplayName,
                Payload = payload,
                Hash = hash,
                FirstSeenAt = now,
            };
            db.ExternalRecords.Add(record);
        }

        var changed = isNew || record.Hash != hash || record.IsGone != input.IsGone;
        record.DisplayName = Truncate(input.DisplayName, 256) ?? "?";
        record.OrgNumber = Truncate(input.OrgNumber, 16);
        record.Email = Truncate(input.Email?.Trim().ToLowerInvariant(), 256);
        record.Phone = Truncate(input.Phone, 32);
        record.Domain = Truncate(input.Domain?.Trim().ToLowerInvariant(), 256);
        record.ParentExternalId = input.ParentExternalId;
        record.Payload = payload;
        record.Hash = hash;
        record.LastSeenAt = now;
        record.ExternalChangedAt = input.ExternalChangedAt ?? record.ExternalChangedAt;
        record.IsGone = input.IsGone;
        await db.SaveChangesAsync(cancellationToken);
        return new UpsertOutcome(record, isNew, changed);
    }

    /// <summary>Clears what a mirrored person record says about them (DEV-11); returns false when it was already bare.</summary>
    public static bool Redact(ExternalRecord record)
    {
        if (record.Payload == RedactedPayload && record.Email is null && record.Phone is null && record.DisplayName == "—")
        {
            return false;
        }

        record.DisplayName = "—";
        record.Email = null;
        record.Phone = null;
        record.OrgNumber = null;
        record.Domain = null;
        record.Payload = RedactedPayload;
        record.Hash = RedactedHash;
        return true;
    }

    private async Task<UpsertOutcome> KeepRedactedAsync(ExternalRecordInput input, CancellationToken cancellationToken)
    {
        var now = timeProvider.GetUtcNow();
        var record = await db.ExternalRecords.SingleOrDefaultAsync(
            r => r.System == input.System && r.ExternalType == input.ExternalType && r.ExternalId == input.ExternalId, cancellationToken);
        var isNew = record is null;
        if (record is null)
        {
            record = new ExternalRecord
            {
                Id = SequentialId.New(now),
                System = input.System,
                ExternalType = input.ExternalType,
                ExternalId = input.ExternalId,
                DisplayName = "—",
                Payload = RedactedPayload,
                Hash = RedactedHash,
                FirstSeenAt = now,
            };
            db.ExternalRecords.Add(record);
        }

        Redact(record);
        record.ParentExternalId = input.ParentExternalId;
        record.LastSeenAt = now;
        record.IsGone = input.IsGone;
        await db.SaveChangesAsync(cancellationToken);
        return new UpsertOutcome(record, isNew, Changed: false);
    }

    /// <summary>After a full scan: records not seen since <paramref name="scanStartedAt"/> are marked as gone.</summary>
    public Task<int> MarkUnseenAsGoneAsync(string system, string externalType, DateTimeOffset scanStartedAt, CancellationToken cancellationToken) =>
        db.ExternalRecords
            .Where(r => r.System == system && r.ExternalType == externalType && !r.IsGone && r.LastSeenAt < scanStartedAt)
            .ExecuteUpdateAsync(s => s.SetProperty(r => r.IsGone, true), cancellationToken);

    public Task<ExternalRecord?> FindAsync(string system, string externalType, string externalId, CancellationToken cancellationToken) =>
        db.ExternalRecords.AsNoTracking()
            .SingleOrDefaultAsync(r => r.System == system && r.ExternalType == externalType && r.ExternalId == externalId, cancellationToken);

    public static T? Read<T>(ExternalRecord record) => JsonSerializer.Deserialize<T>(record.Payload, JsonOptions);

    private static string? Truncate(string? value, int length) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Length > length ? value[..length] : value;
}
