using System.Globalization;
using System.Text.Json;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Crm.SharedKernel.Text;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Organizations;

public sealed record MigrationRunItem(
    Guid Id,
    string Mode,
    string Status,
    string SourceSha256,
    string MappingVersion,
    string RepeatKey,
    int RowsTotal,
    int Created,
    int Updated,
    int Unchanged,
    int Conflicts,
    int Rejected,
    int Contacts,
    int LastCommittedLine,
    int? FailedFromLine,
    int? FailedToLine,
    string? FailureCode,
    DateTimeOffset StartedAt,
    DateTimeOffset? FinishedAt,
    Guid? UserId);

/// <summary>A stored outcome: line, code, ids and field names — never a name, an address or a value.</summary>
public sealed record MigrationOutcomeItem(
    Guid Id,
    int Line,
    string Action,
    string? ReasonCode,
    Guid? OrganizationId,
    Guid? ContactId,
    string? ContactAction,
    IReadOnlyList<string> FieldsChanged,
    IReadOnlyList<string> ConflictFields,
    IReadOnlyList<string> Warnings);

/// <summary>A record a run created or changed: the batch marker, the compensation list of the run.</summary>
public sealed record MigrationBatchEntity(Guid Id, string EntityType, Guid EntityId, string Action, IReadOnlyList<string> Fields);

/// <summary>Reads the manifest of migration runs (DEV-20): the answer of a run, its rows and its batch marker.</summary>
internal sealed class MigrationRunReader(CustomersDbContext db)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<MigrationResult> ResultAsync(
        ImportRun run, bool repeated, IReadOnlyDictionary<int, (string? Name, string? OrgNumber)>? names, CancellationToken ct)
    {
        var outcomes = db.ImportRowOutcomes.AsNoTracking().Where(o => o.RunId == run.Id);
        var reasonCounts = (await outcomes.Where(o => o.ReasonCode != null)
                .GroupBy(o => o.ReasonCode!).Select(g => new { Code = g.Key, Count = g.Count() }).ToListAsync(ct))
            .OrderByDescending(g => g.Count).ThenBy(g => g.Code, StringComparer.Ordinal)
            .ToDictionary(g => g.Code, g => g.Count, StringComparer.Ordinal);

        var warningRows = await outcomes.Where(o => o.Warnings != null).OrderBy(o => o.Line).Select(o => new { o.Line, o.Warnings }).ToListAsync(ct);
        var warningCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        var warnings = new List<string>();
        var summary = ReadSummary(run);
        warnings.AddRange(summary.IgnoredColumns.Select(c => $"Column '{c}': COLUMN_IGNORED"));
        warnings.AddRange(summary.FileWarnings.Select(w => $"File: {w}"));
        foreach (var row in warningRows)
        {
            foreach (var code in row.Warnings!.Split(',', StringSplitOptions.RemoveEmptyEntries))
            {
                warningCounts[code] = warningCounts.GetValueOrDefault(code) + 1;
                warnings.Add($"Row {row.Line}: {code}");
            }
        }

        var sample = await outcomes.Where(o => o.Action != ImportAction.Unchanged)
            .OrderBy(o => o.Action == ImportAction.Rejected || o.Action == ImportAction.Conflict ? 0 : 1).ThenBy(o => o.Line)
            .Take(MigrationImportService.MaxRowsListed)
            .ToListAsync(ct);
        var rows = sample.Select(o =>
        {
            var known = names is not null && names.TryGetValue(o.Line, out var n) ? n : (Name: null, OrgNumber: null);
            return new MigrationRow(
                o.Line, known.Name, known.OrgNumber, o.Action, o.ReasonCode, o.OrganizationId, o.ReasonCode,
                Split(o.FieldsChanged), Split(o.ConflictFields), Split(o.Warnings), o.ContactAction);
        }).ToList();

        return new MigrationResult(
            run.Created, run.Updated, run.Unchanged, run.ContactsWritten, run.Conflict, run.Rejected,
            rows, WarningList.Capped(warnings),
            run.Id, run.SourceSha256, run.MappingVersion, run.RepeatKey, run.Mode.ToString(), run.Status.ToString(),
            run.RowsTotal, run.Rejected, run.LastCommittedLine, reasonCounts,
            warningCounts.OrderByDescending(w => w.Value).ThenBy(w => w.Key, StringComparer.Ordinal).ToDictionary(w => w.Key, w => w.Value, StringComparer.Ordinal),
            summary.Owners, summary.ValidatedNotImported,
            run.FailedFromLine, run.FailedToLine, run.FailureCode, repeated);
    }

    public async Task<PagedResult<MigrationRunItem>> ListAsync(string? cursor, int? limit, CancellationToken ct)
    {
        var take = KeysetCursor.ClampLimit(limit);
        var runs = db.ImportRuns.AsNoTracking();
        var total = await runs.CountAsync(ct);
        if (KeysetCursor.Decode(cursor) is { } at && DateTimeOffset.TryParse(at.SortKey, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var startedAt))
        {
            runs = runs.Where(r => r.StartedAt < startedAt || (r.StartedAt == startedAt && r.Id.CompareTo(at.Id) < 0));
        }

        var page = await runs.OrderByDescending(r => r.StartedAt).ThenByDescending(r => r.Id).Take(take + 1).ToListAsync(ct);
        var items = page.Take(take).ToList();
        var next = page.Count > take ? new KeysetCursor(items[^1].StartedAt.ToString("O", CultureInfo.InvariantCulture), items[^1].Id).Encode() : null;
        return new PagedResult<MigrationRunItem>(items.Select(ToItem).ToList(), next, total);
    }

    public async Task<Result<MigrationResult>> GetAsync(Guid id, CancellationToken ct)
    {
        var run = await db.ImportRuns.AsNoTracking().SingleOrDefaultAsync(r => r.Id == id, ct);
        return run is null ? NotFound(id) : await ResultAsync(run, repeated: false, null, ct);
    }

    public async Task<Result<PagedResult<MigrationOutcomeItem>>> RowsAsync(Guid id, string? action, string? cursor, int? limit, CancellationToken ct)
    {
        if (!await db.ImportRuns.AsNoTracking().AnyAsync(r => r.Id == id, ct))
        {
            return NotFound(id);
        }

        var take = KeysetCursor.ClampLimit(limit);
        var rows = db.ImportRowOutcomes.AsNoTracking().Where(o => o.RunId == id);
        if (!string.IsNullOrWhiteSpace(action))
        {
            var wanted = action.Trim();
            rows = rows.Where(o => o.Action == wanted);
        }

        var total = await rows.CountAsync(ct);
        if (KeysetCursor.Decode(cursor) is { } at && int.TryParse(at.SortKey, NumberStyles.Integer, CultureInfo.InvariantCulture, out var line))
        {
            rows = rows.Where(o => o.Line > line || (o.Line == line && o.Id.CompareTo(at.Id) > 0));
        }

        var page = await rows.OrderBy(o => o.Line).ThenBy(o => o.Id).Take(take + 1).ToListAsync(ct);
        var items = page.Take(take).ToList();
        var next = page.Count > take ? new KeysetCursor(items[^1].Line.ToString(CultureInfo.InvariantCulture), items[^1].Id).Encode() : null;
        return new PagedResult<MigrationOutcomeItem>(items.Select(ToItem).ToList(), next, total);
    }

    public async Task<Result<PagedResult<MigrationBatchEntity>>> EntitiesAsync(Guid id, string? cursor, int? limit, CancellationToken ct)
    {
        if (!await db.ImportRuns.AsNoTracking().AnyAsync(r => r.Id == id, ct))
        {
            return NotFound(id);
        }

        var take = KeysetCursor.ClampLimit(limit);
        var entities = db.ImportRunEntities.AsNoTracking().Where(e => e.RunId == id);
        var total = await entities.CountAsync(ct);
        if (KeysetCursor.Decode(cursor) is { } at)
        {
            var type = at.SortKey;
            entities = entities.Where(e => e.EntityType.CompareTo(type) > 0 || (e.EntityType == type && e.Id.CompareTo(at.Id) > 0));
        }

        var page = await entities.OrderBy(e => e.EntityType).ThenBy(e => e.Id).Take(take + 1).ToListAsync(ct);
        var items = page.Take(take).ToList();
        var next = page.Count > take ? new KeysetCursor(items[^1].EntityType, items[^1].Id).Encode() : null;
        return new PagedResult<MigrationBatchEntity>(
            items.Select(e => new MigrationBatchEntity(e.Id, e.EntityType, e.EntityId, e.Action, Split(e.Fields))).ToList(), next, total);
    }

    private static Error NotFound(Guid id) => Error.NotFound("CUS_IMPORT_RUN_NOT_FOUND", $"Import run {id} was not found.");

    private static MigrationRunItem ToItem(ImportRun r) => new(
        r.Id, r.Mode.ToString(), r.Status.ToString(), r.SourceSha256, r.MappingVersion, r.RepeatKey, r.RowsTotal, r.Created, r.Updated,
        r.Unchanged, r.Conflict, r.Rejected, r.ContactsWritten, r.LastCommittedLine, r.FailedFromLine, r.FailedToLine, r.FailureCode,
        r.StartedAt, r.FinishedAt, r.UserId);

    private static MigrationOutcomeItem ToItem(ImportRowOutcome o) => new(
        o.Id, o.Line, o.Action, o.ReasonCode, o.OrganizationId, o.ContactId, o.ContactAction,
        Split(o.FieldsChanged), Split(o.ConflictFields), Split(o.Warnings));

    private static string[] Split(string? value) =>
        string.IsNullOrEmpty(value) ? [] : value.Split(',', StringSplitOptions.RemoveEmptyEntries);

    private static MigrationSummary ReadSummary(ImportRun run)
    {
        var empty = new MigrationSummary([], [], new OwnerCoverage(false, 0, 0, 0), new Dictionary<string, int>());
        if (string.IsNullOrEmpty(run.SummaryJson))
        {
            return empty;
        }

        try
        {
            return JsonSerializer.Deserialize<MigrationSummary>(run.SummaryJson, Json) ?? empty;
        }
        catch (JsonException)
        {
            return empty;
        }
    }
}
