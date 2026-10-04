using System.Globalization;
using System.Text.Json;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Results;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Reports;

/// <summary>What one capture of a month did to one dataset.</summary>
public sealed record SnapshotTaken(string Dataset, int Revision, string Provenance);

/// <summary>What the store keeps of a snapshot: the table as it was read, who and why, and its hash.</summary>
public sealed record SnapshotDocument(
    string SchemaVersion, string Dataset, string Month, int Revision, string Provenance, DateTimeOffset AsOf, string CapturedBy, string? Reason,
    DateOnly From, DateOnly To, IReadOnlyList<BiColumn> Columns, IReadOnlyList<IReadOnlyList<JsonElement>> Rows, string Sha256);

/// <summary>
/// Historical figures of closed months (DEV-14, ADR-022). The live datasets read what the modules hold now, which later edits
/// (a price list, a customer's category, the internal hourly cost) can move; a snapshot is the table as it was read when the
/// month had closed, kept as an object that is only ever added to — a correction is a new revision, the old one stays.
/// Reporting owns no database schema, so the objects live in the document store, like the maintenance journal (ADR-021).
/// A snapshot taken more than <see cref="ReportsOptions.SnapshotTimelyDays"/> after the month ended says <c>Reconstructed</c>:
/// it is built from current data and is not passed off as the state at month end.
/// </summary>
internal sealed class BiSnapshotService(IDocumentStore store, BiService bi, TimeProvider time, IOptions<ReportsOptions> options, ILogger<BiSnapshotService> logger)
{
    public const string Prefix = "reports/snapshots/";
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>Taken within <paramref name="timelyDays"/> of the month's end it is the state at close; later it is rebuilt from current data.</summary>
    public static string ProvenanceOf(DateOnly today, DateOnly lastDayOfMonth, int timelyDays) =>
        today <= lastDayOfMonth.AddDays(timelyDays) ? "Captured" : "Reconstructed";

    public static DateOnly MonthOf(string month) =>
        DateOnly.TryParseExact(month + "-01", "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var first) ? first : default;

    public static string Folder(string dataset, string month) => $"{Prefix}{dataset}/{month}/";

    private static string Key(string dataset, string month, int revision) =>
        string.Create(CultureInfo.InvariantCulture, $"{Folder(dataset, month)}r{revision:D3}.json");

    /// <summary>The month's datasets that have no snapshot yet (all of them with <paramref name="revise"/>: a new revision of each).</summary>
    public async Task<Result<IReadOnlyList<SnapshotTaken>>> CaptureAsync(string month, string capturedBy, string? reason, bool revise, CancellationToken ct)
    {
        var first = MonthOf(month);
        if (first == default || first.Year < 2020 || first.Year > 2100)
        {
            return Error.Validation("RPT_SNAPSHOT_MONTH", "Give the month as yyyy-MM.");
        }

        var last = first.AddMonths(1).AddDays(-1);
        var now = time.GetUtcNow();
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, Oslo).DateTime);
        if (today <= last)
        {
            return Error.Conflict("RPT_SNAPSHOT_MONTH_OPEN", "A month is closed for reporting after its last day: take the snapshot from the next day on.");
        }

        var provenance = ProvenanceOf(today, last, options.Value.SnapshotTimelyDays);
        var taken = new List<SnapshotTaken>();
        foreach (var dataset in BiService.Datasets.Where(d => d.Snapshot))
        {
            var existing = await RevisionsAsync(dataset.Name, month, ct);
            if (existing.Count > 0 && !revise)
            {
                continue;
            }

            var table = await bi.BuildAsync(dataset, first, last, now, ct);
            if (!table.IsSuccess)
            {
                return table.Error!;
            }

            var revision = (existing.Count == 0 ? 0 : existing.Max()) + 1;
            var rows = table.Value.Rows.Select(r => (IReadOnlyList<JsonElement>)r.Select(v => JsonSerializer.SerializeToElement(v, Json)).ToList()).ToList();
            var sha = DocumentHashes.Sha256(JsonSerializer.SerializeToUtf8Bytes(new { table.Value.Columns, Rows = rows }, Json));
            var document = new SnapshotDocument(
                BiService.SchemaVersion, dataset.Name, month, revision, provenance, now, capturedBy, reason, first, last, dataset.Columns, rows, sha);
            var stored = await store.PutAsync(Key(dataset.Name, month, revision), JsonSerializer.SerializeToUtf8Bytes(document, Json), "application/json", ct);
            if (!stored.Created)
            {
                return Error.Conflict("RPT_SNAPSHOT_RACE", "Another snapshot of this month was taken at the same moment; read it and decide whether a revision is needed.");
            }

            taken.Add(new SnapshotTaken(dataset.Name, revision, provenance));
        }

        if (taken.Count == 0)
        {
            return Error.Conflict("RPT_SNAPSHOT_EXISTS", "This month already has its snapshot. A correction is a new revision (revise), the first one stays.");
        }

        logger.LogInformation("Reporting snapshot of {Month}: {Datasets} dataset(s), {Provenance}, by {By}", month, taken.Count, provenance, capturedBy);
        return taken;
    }

    public async Task<IReadOnlyList<int>> RevisionsAsync(string dataset, string month, CancellationToken ct)
    {
        var revisions = new List<int>();
        await foreach (var item in store.ListAsync(Folder(dataset, month), ct))
        {
            var name = item.Key[(item.Key.LastIndexOf('/') + 1)..];
            if (name.StartsWith('r') && name.EndsWith(".json", StringComparison.Ordinal) &&
                int.TryParse(name[1..^5], NumberStyles.None, CultureInfo.InvariantCulture, out var revision))
            {
                revisions.Add(revision);
            }
        }

        return revisions;
    }

    /// <summary>The latest revision of a month's dataset, or the one asked for; the hash is checked on the way out.</summary>
    public async Task<Result<SnapshotDocument>> ReadAsync(string dataset, string month, int? revision, CancellationToken ct)
    {
        var revisions = await RevisionsAsync(dataset, month, ct);
        var wanted = revision ?? (revisions.Count == 0 ? 0 : revisions.Max());
        if (wanted == 0 || !revisions.Contains(wanted))
        {
            return Error.NotFound("RPT_SNAPSHOT_NOT_FOUND", $"There is no snapshot of '{dataset}' for {month}{(revision is null ? string.Empty : $" revision {revision}")}.");
        }

        var bytes = await store.ReadAsync(Key(dataset, month, wanted), ct);
        var document = bytes is null ? null : JsonSerializer.Deserialize<SnapshotDocument>(bytes, Json);
        if (document is null)
        {
            return Error.NotFound("RPT_SNAPSHOT_NOT_FOUND", $"The snapshot of '{dataset}' for {month} could not be read.");
        }

        var sha = DocumentHashes.Sha256(JsonSerializer.SerializeToUtf8Bytes(new { document.Columns, document.Rows }, Json));
        return sha == document.Sha256
            ? document
            : Error.Conflict("RPT_SNAPSHOT_CORRUPT", "The stored snapshot does not match its hash; it is not served.");
    }

    /// <summary>The first day of the month before today (Oslo): the month the monthly job closes.</summary>
    public string PreviousMonth()
    {
        var today = TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo);
        var first = new DateOnly(today.Year, today.Month, 1).AddMonths(-1);
        return first.ToString("yyyy-MM", CultureInfo.InvariantCulture);
    }
}

/// <summary>Takes the previous month's snapshot once the month has closed (daily; only datasets that have none are taken).</summary>
public sealed class BiSnapshotJob(IServiceScopeFactory scopes, ILogger<BiSnapshotJob> logger)
{
    public const string JobId = "reports-snapshot";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var snapshots = scope.ServiceProvider.GetRequiredService<BiSnapshotService>();
        var month = snapshots.PreviousMonth();
        var result = await snapshots.CaptureAsync(month, "reports-snapshot job", "Monthly close", revise: false, cancellationToken);
        if (!result.IsSuccess && result.Error!.Code != "RPT_SNAPSHOT_EXISTS")
        {
            logger.LogWarning("Reporting snapshot of {Month} failed: {Code}", month, result.Error.Code);
        }
    }
}
