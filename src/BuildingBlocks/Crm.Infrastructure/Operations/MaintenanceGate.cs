using System.Globalization;
using System.Text.Json;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Infrastructure.Operations;

public sealed class MaintenanceOptions
{
    public const string SectionName = "Maintenance";

    /// <summary>
    /// Read-only whatever the document store says — for an outage of the store itself or a deployment that must start read-only.
    /// Lifting it takes a new revision; the operator's switch cannot.
    /// </summary>
    public bool ForceReadOnly { get; set; }

    public string? ForceReason { get; set; }

    /// <summary>How long one process trusts the state it read for requests and database writes; sends always read it again.</summary>
    public int CacheSeconds { get; set; } = 5;
}

/// <summary>
/// The maintenance switch of DEV-13 (ADR-021). Each decision is a new object under <see cref="Prefix"/> in the document store —
/// the store keeps objects for good, so the series is also the switch's own audit trail — and the newest one counts. The store
/// lies outside the business database: a restore cannot undo the switch, and a migration of that database cannot block it.
/// </summary>
internal sealed class DocumentStoreMaintenanceGate(
    IDocumentStore store, IOptionsMonitor<MaintenanceOptions> options, TimeProvider time, ILogger<DocumentStoreMaintenanceGate> logger)
    : IMaintenanceGate, IDisposable
{
    public const string Prefix = "operations/maintenance/";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    private readonly SemaphoreSlim _read = new(1, 1);
    private (MaintenanceState State, DateTimeOffset At)? _cached;

    public MaintenanceState Last => Forced() ?? _cached?.State ?? MaintenanceState.Normal;

    public async ValueTask<MaintenanceState> CurrentAsync(CancellationToken cancellationToken)
    {
        if (Forced() is { } forced)
        {
            return forced;
        }

        if (_cached is { } cached && time.GetUtcNow() - cached.At < TimeSpan.FromSeconds(options.CurrentValue.CacheSeconds))
        {
            return cached.State;
        }

        await _read.WaitAsync(cancellationToken);
        try
        {
            if (_cached is { } fresh && time.GetUtcNow() - fresh.At < TimeSpan.FromSeconds(options.CurrentValue.CacheSeconds))
            {
                return fresh.State;
            }

            return await ReadAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Requests go on with the last known state: an outage of the store must not take the CRM down. Sends do not — they
            // ask FreshAsync, which fails closed.
            logger.LogWarning("The maintenance state could not be read from the document store ({Error}).", ex.GetType().Name);
            return _cached?.State ?? MaintenanceState.Normal;
        }
        finally
        {
            _read.Release();
        }
    }

    public async Task<MaintenanceState> FreshAsync(CancellationToken cancellationToken)
    {
        if (Forced() is { } forced)
        {
            return forced;
        }

        try
        {
            return await ReadAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            throw new MaintenanceStateUnavailableException(ex);
        }
    }

    public async Task<MaintenanceState> SetAsync(
        MaintenanceMode mode, string reason, string? reference, string setBy, string? expectedKey, CancellationToken cancellationToken)
    {
        if (Forced() is { } forced)
        {
            throw new MaintenanceConflictException(forced);
        }

        var current = await FreshAsync(cancellationToken);
        if (!string.Equals(expectedKey ?? string.Empty, current.Key ?? string.Empty, StringComparison.Ordinal))
        {
            throw new MaintenanceConflictException(current);
        }

        var at = time.GetUtcNow();
        var key = string.Create(CultureInfo.InvariantCulture, $"{Prefix}{at.UtcDateTime:yyyyMMdd'T'HHmmssfffffff'Z'}-{Guid.NewGuid():N}.json");
        var state = new MaintenanceState(mode, reason, reference, setBy, at, key);
        await store.PutAsync(key, JsonSerializer.SerializeToUtf8Bytes(new Stored(mode, reason, reference, setBy, at), Json), "application/json", cancellationToken);
        _cached = (state, time.GetUtcNow());
        // The reason is typed by a person: no line break may reach the console as a line of its own (F-G5-10).
        logger.LogWarning(
            "MAINTENANCE {Mode} set by {SetBy}: {Reason} ({Reference})",
            mode, Crm.SharedKernel.Text.LogText.Clean(setBy), Crm.SharedKernel.Text.LogText.Clean(reason), Crm.SharedKernel.Text.LogText.Clean(reference));
        return state;
    }

    public void Dispose() => _read.Dispose();

    private async Task<MaintenanceState> ReadAsync(CancellationToken cancellationToken)
    {
        string? newest = null;
        await foreach (var item in store.ListAsync(Prefix, cancellationToken))
        {
            if (item.Key.EndsWith(".json", StringComparison.Ordinal) && (newest is null || string.CompareOrdinal(item.Key, newest) > 0))
            {
                newest = item.Key;
            }
        }

        var state = MaintenanceState.Normal;
        if (newest is not null && await store.ReadAsync(newest, cancellationToken) is { } bytes)
        {
            var stored = JsonSerializer.Deserialize<Stored>(bytes, Json) ?? throw new JsonException("The maintenance decision is empty.");
            state = new MaintenanceState(stored.Mode, stored.Reason, stored.Reference, stored.SetBy, stored.At, newest);
        }

        _cached = (state, time.GetUtcNow());
        return state;
    }

    private MaintenanceState? Forced() => options.CurrentValue.ForceReadOnly
        ? new MaintenanceState(MaintenanceMode.ReadOnly, options.CurrentValue.ForceReason ?? "Maintenance:ForceReadOnly is set for this deployment.", null, "configuration", DateTimeOffset.MinValue, null)
        : null;

    private sealed record Stored(MaintenanceMode Mode, string? Reason, string? Reference, string? SetBy, DateTimeOffset At);
}
