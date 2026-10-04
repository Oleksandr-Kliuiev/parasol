using System.Globalization;
using System.Text.Json;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.Logging;

namespace Crm.Infrastructure.Operations;

/// <summary>
/// The external effect journal (DEV-13, ADR-021) in the document store: one object per entry under
/// <c>operations/effects/{entity type}/{entity id}/</c>, named by its time, so one record's entries are one listing away and a
/// restore reconciliation can pick the entries after its restore point by name. Entries hold ids, kinds, times and external
/// references — no personal data.
/// </summary>
internal sealed class DocumentStoreEffectJournal(
    IDocumentStore store, IMaintenanceGate maintenance, TimeProvider time, ILogger<DocumentStoreEffectJournal> logger)
    : IExternalEffectJournal
{
    public const string Prefix = "operations/effects/";
    private const string TimeFormat = "yyyyMMdd'T'HHmmssfffffff'Z'";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    public async Task<ExternalEffectEntry> BeginAsync(ExternalEffect effect, CancellationToken cancellationToken)
    {
        // Every send passes here first, so this is where a stale cache of the switch cannot let one through.
        await maintenance.EnsureMaySendAsync(cancellationToken);
        var entry = new ExternalEffectEntry(
            Guid.NewGuid().ToString("N"), effect.System, effect.Kind, effect.EntityType, effect.EntityId, effect.OperationId,
            EffectPhase.Sending, time.GetUtcNow(), null);
        await WriteAsync(entry, cancellationToken);
        return entry;
    }

    public async Task CompleteAsync(ExternalEffectEntry begun, EffectPhase outcome, string? reference, CancellationToken cancellationToken)
    {
        var entry = begun with
        {
            Id = $"{ExternalEffects.AttemptOf(begun)}~{outcome}",
            Phase = outcome,
            At = time.GetUtcNow(),
            Reference = reference is { Length: > 200 } ? reference[..200] : reference,
        };
        try
        {
            await WriteAsync(entry, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(
                "The outcome {Outcome} of {System}/{Kind} for {EntityType} {EntityId} could not be journaled ({Error}); its Sending entry stands.",
                outcome, begun.System, begun.Kind, begun.EntityType, begun.EntityId, ex.GetType().Name);
        }
    }

    public async Task<IReadOnlyList<ExternalEffectEntry>> ForEntityAsync(string entityType, Guid entityId, CancellationToken cancellationToken)
    {
        var entries = new List<ExternalEffectEntry>();
        await foreach (var item in store.ListAsync(Folder(entityType, entityId), cancellationToken))
        {
            if (await ReadAsync(item.Key, cancellationToken) is { } entry)
            {
                entries.Add(entry);
            }
        }

        return entries.OrderBy(e => e.At).ToList();
    }

    public async Task<IReadOnlyList<ExternalEffectEntry>> SinceAsync(DateTimeOffset since, CancellationToken cancellationToken)
    {
        var entries = new List<ExternalEffectEntry>();
        await foreach (var item in store.ListAsync(Prefix, cancellationToken))
        {
            // The name starts with the entry's time: only the entries after the restore point are read.
            var name = item.Key[(item.Key.LastIndexOf('/') + 1)..];
            var stamp = name.Split('-', 2)[0];
            if (DateTimeOffset.TryParseExact(stamp, TimeFormat, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) &&
                at >= since && await ReadAsync(item.Key, cancellationToken) is { } entry)
            {
                entries.Add(entry);
            }
        }

        return entries.OrderBy(e => e.At).ToList();
    }

    private async Task WriteAsync(ExternalEffectEntry entry, CancellationToken cancellationToken)
    {
        // Document keys allow letters, digits, '-', '_' and '.' only: an outcome's object is named by its attempt and phase.
        var name = entry.Phase == EffectPhase.Sending ? entry.Id : $"{ExternalEffects.AttemptOf(entry)}-{entry.Phase}";
        var key = string.Create(CultureInfo.InvariantCulture, $"{Folder(entry.EntityType, entry.EntityId)}{entry.At.UtcDateTime.ToString(TimeFormat, CultureInfo.InvariantCulture)}-{name}.json");
        await store.PutAsync(key, JsonSerializer.SerializeToUtf8Bytes(entry, Json), "application/json", cancellationToken);
    }

    private async Task<ExternalEffectEntry?> ReadAsync(string key, CancellationToken cancellationToken) =>
        await store.ReadAsync(key, cancellationToken) is { } bytes ? JsonSerializer.Deserialize<ExternalEffectEntry>(bytes, Json) : null;

    private static string Folder(string entityType, Guid entityId) =>
        $"{Prefix}{new string(entityType.Where(char.IsAsciiLetterOrDigit).ToArray())}/{entityId:N}/";
}
