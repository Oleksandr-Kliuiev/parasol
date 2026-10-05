using System.Text;
using System.Text.Json;
using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Privacy.Contracts;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Crm.SharedKernel.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Customers.Features.Organizations;

/// <summary>
/// One row of the migration answer: what the file said and what the CRM did with it. The sample in a fresh answer carries the
/// name and number of the file's row; what is stored and read back later (<see cref="ImportRowOutcome"/>) never does.
/// </summary>
public sealed record MigrationRow(
    int Line,
    string? Name,
    string? OrgNumber,
    string Action,
    string? Detail,
    Guid? OrganizationId,
    string? ReasonCode = null,
    IReadOnlyList<string>? FieldsChanged = null,
    IReadOnlyList<string>? ConflictFields = null,
    IReadOnlyList<string>? Warnings = null,
    string? ContactAction = null);

/// <summary>How many rows name an owner the CRM knows, name none, or name one it does not know or that is inactive.</summary>
public sealed record OwnerCoverage(bool ColumnPresent, int Resolved, int Empty, int Unknown);

/// <summary>
/// The answer of a migration import or preview, or of reading a stored run (DEV-20). <c>Failed</c> is the older name of
/// <c>Rejected</c>. Every row of the file is counted exactly once: <c>RowsTotal = Created + Updated + Unchanged + Conflicts + Rejected</c>.
/// </summary>
public sealed record MigrationResult(
    int Created,
    int Updated,
    int Unchanged,
    int Contacts,
    int Conflicts,
    int Failed,
    IReadOnlyList<MigrationRow> Rows,
    IReadOnlyList<string> Warnings,
    Guid RunId,
    string SourceSha256,
    string MappingVersion,
    string RepeatKey,
    string Mode,
    string Status,
    int RowsTotal,
    int Rejected,
    int LastCommittedLine,
    IReadOnlyDictionary<string, int> ReasonCounts,
    IReadOnlyDictionary<string, int> WarningCounts,
    OwnerCoverage Owners,
    IReadOnlyDictionary<string, int> ValidatedNotImported,
    int? FailedFromLine,
    int? FailedToLine,
    string? FailureCode,
    bool Repeated);

/// <summary>What a run keeps about the file itself: counts and codes only.</summary>
internal sealed record MigrationSummary(
    IReadOnlyList<string> IgnoredColumns,
    IReadOnlyList<string> FileWarnings,
    OwnerCoverage Owners,
    IReadOnlyDictionary<string, int> ValidatedNotImported);

/// <summary>
/// Data migration from the old systems (ТЗ §6.6, DEV-20): organizations and their main contact from one file. Matching follows
/// BR-CUS-06 — organization number first, then a shared domain, then the exact name; anything ambiguous is reported for a
/// person to decide instead of being merged silently. The CRM is the master: a matched record is only filled where it has no
/// value, a different value in the file is a field-level conflict and never applied. <c>?dryRun=true</c> runs the same code
/// and writes no organization, contact or event — only the run's manifest. A real run saves in chunks, each in its own
/// transaction, and repeating the same file resumes it after the last committed chunk or, when it completed, returns its result.
/// </summary>
internal sealed class MigrationImportService(
    CustomersDbContext db,
    ICurrentUser currentUser,
    IRequestContext requestContext,
    TimeProvider time,
    ISuppressionList suppressions,
    IUserDirectory users,
    ICatalogApi catalog,
    MigrationRunReader reader,
    IOptions<CustomersOptions> options)
{
    /// <summary>A migration file is a one-off job, not a sync: a few thousand rows at a time keeps the report readable.</summary>
    internal const int MaxRows = 5000;

    /// <summary>Rows an answer lists — conflicts and rejections first, as they need a person; the counts cover the whole file (DEV-12).</summary>
    public const int MaxRowsListed = 200;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<Result<MigrationResult>> ImportAsync(byte[] content, bool dryRun, string? expectedSha256, CancellationToken ct)
    {
        var sha = ImportRun.Sha256Hex(content);
        if (!dryRun && !string.IsNullOrWhiteSpace(expectedSha256) && !string.Equals(expectedSha256.Trim(), sha, StringComparison.OrdinalIgnoreCase))
        {
            return Error.Conflict("IMPORT_SOURCE_CHANGED", "The file differs from the one that was previewed; preview it again.",
                new Dictionary<string, object?> { ["sourceSha256"] = sha });
        }

        var (text, broken) = Decode(content);
        var table = CsvTable.Parse(text, MigrationFile.Aliases);
        if (table is null || !table.Has("name"))
        {
            return Error.Validation("CUS_MIGRATION_INVALID", "The file needs a header row with at least a name column.");
        }

        if (table.RowCount > MaxRows)
        {
            return Error.Validation("CUS_MIGRATION_TOO_LARGE", $"Split the file: at most {MaxRows} rows at a time.");
        }

        var now = time.GetUtcNow();
        ImportRun? run = null;
        if (!dryRun)
        {
            var key = ImportRun.RepeatKeyOf(sha, ImportRun.CurrentMappingVersion);
            run = await db.ImportRuns.SingleOrDefaultAsync(r => r.RepeatKey == key && r.Mode == ImportMode.Real, ct);
            if (run is { Status: ImportRunStatus.Completed })
            {
                // The same file, read the same way, already went through: nothing is written a second time (DEV-20-AC02).
                return await reader.ResultAsync(run, repeated: true, null, ct);
            }

            if (run is { Status: ImportRunStatus.Running } && now - run.UpdatedAt < options.Value.MigrationRunStaleAfter)
            {
                return Error.Conflict("IMPORT_RUN_IN_PROGRESS", "This file is being imported right now; repeat the call when it has finished.",
                    new Dictionary<string, object?> { ["runId"] = run.Id });
            }
        }

        var plan = await PrepareAsync(table, sha, broken, ct);
        var summary = JsonSerializer.Serialize(plan.Summary, Json);
        var includeBilling = options.Value.BillingDetailsMaster != BillingDetailsMaster.PowerOffice;
        var suppressed = await suppressions.SnapshotAsync(ct);
        var scope = new RunScope();
        var names = new Dictionary<int, (string? Name, string? OrgNumber)>();

        if (dryRun)
        {
            var preview = ImportRun.Start(sha, ImportMode.DryRun, plan.Rows.Count, currentUser.UserId, now);
            var outcomes = new List<ImportRowOutcome>(plan.Rows.Count);
            foreach (var row in plan.Rows)
            {
                var result = await ProcessAsync(row, plan, scope, includeBilling, suppressed, ct);
                outcomes.Add(ToOutcome(preview.Id, row, result));
                preview.Count(result.Action, result.ContactsWritten);
                names[row.Line] = (row.Name, row.OrgNumber);
            }

            // Nothing is written: the tracked changes are dropped, so the preview counts exactly what the real run would do.
            db.ChangeTracker.Clear();
            Account(preview);
            preview.Complete(now, summary);
            db.ImportRuns.Add(preview);
            db.ImportRowOutcomes.AddRange(outcomes);
            await db.SaveChangesAsync(ct);
            return await reader.ResultAsync(preview, repeated: false, names, ct);
        }

        if (run is null)
        {
            run = ImportRun.Start(sha, ImportMode.Real, plan.Rows.Count, currentUser.UserId, now);
            run.SetSummary(summary);
            db.ImportRuns.Add(run);
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException)
            {
                // Another call started the same file between the lookup and the insert.
                db.ChangeTracker.Clear();
                return Error.Conflict("IMPORT_RUN_IN_PROGRESS", "This file is being imported right now; repeat the call when it has finished.");
            }
        }
        else
        {
            run.Resume(currentUser.UserId, now);
            run.SetSummary(summary);
            await db.SaveChangesAsync(ct);
        }

        ImportRun active = run;
        var chunkSize = Math.Max(1, options.Value.MigrationChunkSize);
        var pendingOutcomes = new List<ImportRowOutcome>();
        var pendingEntities = new List<ImportRunEntity>();

        // One manifest line per entity and run: a contact first created and then given a phone number (or affiliated) by a later row stays "created".
        var recorded = (await db.ImportRunEntities.AsNoTracking().Where(e => e.RunId == active.Id).Select(e => new { e.EntityType, e.EntityId }).ToListAsync(ct))
            .Select(e => (e.EntityType, e.EntityId)).ToHashSet();
        int chunkFirst = 0, chunkLast = 0, inChunk = 0;
        var runId = active.Id;

        async Task<bool> CommitAsync(bool final)
        {
            try
            {
                var at = time.GetUtcNow();
                if (inChunk > 0)
                {
                    active.Committed(chunkLast, at);
                }

                if (final)
                {
                    Account(active);
                    active.Complete(at, null);
                    db.RecordAudit(currentUser, requestContext, time, "Import", "Organization", Guid.Empty, AuditDetails(active));
                }

                db.ImportRowOutcomes.AddRange(pendingOutcomes);
                db.ImportRunEntities.AddRange(pendingEntities);
                await db.SaveChangesAsync(ct);
                DetachCommitted();
                scope.Clear();
                pendingOutcomes.Clear();
                pendingEntities.Clear();
                inChunk = 0;
                chunkFirst = 0;
                return true;
            }
            catch (DbUpdateException)
            {
                // The chunk is rolled back as a whole: the rows before it stay committed, the file resumes after them.
                db.ChangeTracker.Clear();
                active = await db.ImportRuns.SingleAsync(r => r.Id == runId, ct);
                active.Interrupt(ImportRunStatus.Partial, ImportReason.ChunkFailed, chunkFirst == 0 ? null : chunkFirst, chunkLast == 0 ? null : chunkLast, time.GetUtcNow());
                db.RecordAudit(currentUser, requestContext, time, "Import", "Organization", Guid.Empty, AuditDetails(active));
                await db.SaveChangesAsync(ct);
                return false;
            }
        }

        try
        {
            foreach (var row in plan.Rows.Where(r => r.Line > active.LastCommittedLine))
            {
                var result = await ProcessAsync(row, plan, scope, includeBilling, suppressed, ct);
                var outcome = ToOutcome(runId, row, result);
                pendingOutcomes.Add(outcome);
                pendingEntities.AddRange(result.Entities.Where(e => recorded.Add((e.Type, e.Id))).Select(e => ImportRunEntity.Create(runId, e.Type, e.Id, e.Action, e.Fields)));
                active.Count(result.Action, result.ContactsWritten);
                names[row.Line] = (row.Name, row.OrgNumber);
                chunkFirst = chunkFirst == 0 ? row.Line : chunkFirst;
                chunkLast = row.Line;
                inChunk++;
                if (inChunk >= chunkSize && !await CommitAsync(final: false))
                {
                    return await reader.ResultAsync(active, repeated: false, names, ct);
                }
            }

            if (!await CommitAsync(final: true))
            {
                return await reader.ResultAsync(active, repeated: false, names, ct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not DbUpdateException)
        {
            // Not a database problem: the chunks that were committed stay, the run says it did not finish.
            db.ChangeTracker.Clear();
            var failed = await db.ImportRuns.SingleAsync(r => r.Id == runId, ct);
            failed.Interrupt(ImportRunStatus.Failed, "IMPORT_FAILED", null, null, time.GetUtcNow());
            await db.SaveChangesAsync(CancellationToken.None);
            throw;
        }

        return await reader.ResultAsync(active, repeated: false, names, ct);
    }

    private static object AuditDetails(ImportRun run) => new
    {
        Source = "Migration",
        RunId = run.Id,
        run.Status,
        Rows = run.RowsTotal,
        run.Created,
        run.Updated,
        run.Unchanged,
        run.Conflict,
        run.Rejected,
        run.LastCommittedLine,
    };

    private static void Account(ImportRun run)
    {
        // Every source row has exactly one result (DEV-20-AC03): a count that does not add up is a bug, not a report.
        if (!run.Accounted)
        {
            throw new InvalidOperationException("The migration run does not account for every row of its file.");
        }
    }

    private void DetachCommitted()
    {
        foreach (var entry in db.ChangeTracker.Entries().Where(e => e.Entity is not ImportRun).ToList())
        {
            entry.State = EntityState.Detached;
        }
    }

    private static ImportRowOutcome ToOutcome(Guid runId, MigrationRowData row, RowResult result) => ImportRowOutcome.Create(
        runId, row.Line, row.SourceKey, result.Action, result.Reason, result.OrganizationId, result.ContactId, result.ContactAction,
        result.Fields, result.Conflicts, result.Warnings);

    /// <summary>Reads the bytes of an uploaded file: UTF-8 with or without a BOM, or UTF-16 with one. Bytes that are none of these become U+FFFD.</summary>
    internal static (string Text, bool Broken) Decode(byte[] content)
    {
        string text;
        if (content is [0xFF, 0xFE, ..])
        {
            text = Encoding.Unicode.GetString(content);
        }
        else if (content is [0xFE, 0xFF, ..])
        {
            text = Encoding.BigEndianUnicode.GetString(content);
        }
        else
        {
            // UTF-8 with or without a BOM; bytes that are not UTF-8 become U+FFFD, which the rows that hold them are rejected for.
            text = new UTF8Encoding(false, false).GetString(content);
        }

        return (text.TrimStart('﻿'), text.Contains('�', StringComparison.Ordinal));
    }

    /// <summary>Everything that needs the whole file or the CRM and can be decided before the first row is written.</summary>
    private sealed class Plan
    {
        public required List<MigrationRowData> Rows { get; init; }
        public required MigrationSummary Summary { get; init; }
        public Dictionary<int, HashSet<Guid>> NearCrm { get; } = [];
        public HashSet<int> NearFile { get; } = [];
    }

    private async Task<Plan> PrepareAsync(CsvTable table, string sha, bool broken, CancellationToken ct)
    {
        var rows = Enumerable.Range(0, table.RowCount).Select(i => MigrationFile.ReadRow(table, i, sha, broken)).ToList();

        // Owners: the CRM user each e-mail names; an unknown or inactive one is refused, not guessed.
        var ownerColumn = table.Has("owner");
        var resolvedOwners = await users.FindByEmailsAsync(
            rows.Where(r => r.OwnerEmail is not null && MigrationFile.IsEmail(r.OwnerEmail)).Select(r => r.OwnerEmail!).Distinct().ToList(), ct);
        int ownersResolved = 0, ownersEmpty = 0, ownersUnknown = 0;
        foreach (var row in rows)
        {
            if (row.OwnerEmail is null)
            {
                ownersEmpty++;
                if (ownerColumn)
                {
                    row.Warnings.Add(ImportReason.OwnerEmpty);
                }
            }
            else if (resolvedOwners.TryGetValue(row.OwnerEmail, out var owner) && owner.IsActive)
            {
                ownersResolved++;
                row.OwnerId = owner.Id;
            }
            else
            {
                ownersUnknown++;
                row.Reject(ImportReason.OwnerUnknown);
            }
        }

        // The CRM side of references and products.
        var parentNumbers = rows.Where(r => !r.Rejected && r.ParentOrgNumber is not null).Select(r => r.ParentOrgNumber!).Distinct().ToList();
        var parentsInCrm = parentNumbers.Count == 0
            ? new HashSet<string>()
            : (await db.Organizations.AsNoTracking().Where(o => o.OrgNumber != null && parentNumbers.Contains(o.OrgNumber)).Select(o => o.OrgNumber!).ToListAsync(ct)).ToHashSet();
        var skus = rows.Where(r => !r.Rejected && r.ProductSku is not null).Select(r => r.ProductSku!).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var knownSkus = skus.Count == 0 ? new Dictionary<string, Guid>() : new Dictionary<string, Guid>(await catalog.FindProductsBySkuAsync(skus, ct), StringComparer.OrdinalIgnoreCase);

        // Duplicates inside the file, and references to rows earlier in it. A contact e-mail may repeat on rows of different
        // organizations (one person, several affiliations); a second row of the same organization is already the duplicate.
        var numbers = new HashSet<string>(StringComparer.Ordinal);
        var namesSeen = new Dictionary<string, List<string?>>(StringComparer.Ordinal);
        var externalIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in rows.Where(r => !r.Rejected))
        {
            var nameKey = DuplicateDetector.NormalizeName(row.Name!);
            var externalKey = row.ExternalSystem is not null && row.ExternalId is not null ? $"{row.ExternalSystem.ToLowerInvariant()}|{row.ExternalId}" : null;
            var duplicate =
                (row.OrgNumber is not null && numbers.Contains(row.OrgNumber)) ||
                (nameKey.Length > 0 && namesSeen.TryGetValue(nameKey, out var earlier) && earlier.Any(n => n is null || row.OrgNumber is null || n == row.OrgNumber)) ||
                (externalKey is not null && externalIds.Contains(externalKey));
            if (duplicate)
            {
                row.Reject(ImportReason.DuplicateInFile);
                continue;
            }

            if (row.ParentOrgNumber is { } parent && !parentsInCrm.Contains(parent) && !numbers.Contains(parent))
            {
                row.Reject(ImportReason.BrokenReference);
                continue;
            }

            if (row.OrgNumber is not null)
            {
                numbers.Add(row.OrgNumber);
            }

            if (nameKey.Length > 0)
            {
                if (!namesSeen.TryGetValue(nameKey, out var list))
                {
                    namesSeen[nameKey] = list = [];
                }

                list.Add(row.OrgNumber);
            }

            if (externalKey is not null)
            {
                externalIds.Add(externalKey);
            }

            if (row.ProductSku is not null && !knownSkus.ContainsKey(row.ProductSku))
            {
                row.Warnings.Add(ImportReason.UnknownProduct);
            }
        }

        var validated = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var row in rows.Where(r => !r.Rejected))
        {
            foreach (var column in MigrationFile.ValidatedValues(row))
            {
                validated[column] = validated.GetValueOrDefault(column) + 1;
            }
        }

        var fileWarnings = new List<string>();
        if (broken)
        {
            fileWarnings.Add("ENCODING_REPLACEMENT_CHARS");
        }

        var summary = new MigrationSummary(
            table.UnknownColumns.Take(30).Select(c => c.Length > 48 ? c[..48] : c).ToList(),
            fileWarnings,
            new OwnerCoverage(ownerColumn, ownersResolved, ownersEmpty, ownersUnknown),
            validated);
        var plan = new Plan { Rows = rows, Summary = summary };
        await FindNearDuplicatesAsync(plan, ct);
        return plan;
    }

    /// <summary>
    /// Names and numbers that look alike but are not the same record: reported as a warning on the row, never merged or linked
    /// (DEV-20: no business link is guessed from similar names). Organizations with two different numbers are never reported.
    /// </summary>
    private async Task FindNearDuplicatesAsync(Plan plan, CancellationToken ct)
    {
        var fileRows = plan.Rows.Where(r => !r.Rejected).ToList();
        if (fileRows.Count == 0)
        {
            return;
        }

        var byCandidate = new Dictionary<Guid, MigrationRowData>();
        var candidates = new List<DuplicateCandidate>();
        foreach (var row in fileRows)
        {
            var id = Guid.NewGuid();
            byCandidate[id] = row;
            candidates.Add(new DuplicateCandidate(id, row.Name!, row.OrgNumber, row.Email, row.Phone, row.Domain is null ? [] : [row.Domain]));
        }

        var crm = await db.Organizations.AsNoTracking()
            .Select(o => new { o.Id, o.Name, o.OrgNumber, o.Email, o.Phone, o.Domains })
            .ToListAsync(ct);
        candidates.AddRange(crm.Select(o => new DuplicateCandidate(o.Id, o.Name, o.OrgNumber, o.Email, o.Phone, o.Domains)));

        foreach (var pair in DuplicateDetector.Find(candidates, new HashSet<(Guid, Guid)>()))
        {
            if (!pair.Reasons.Any(r => r is DuplicateReason.SameName or DuplicateReason.SharedDomain or DuplicateReason.SamePhone))
            {
                continue;
            }

            var first = byCandidate.GetValueOrDefault(pair.FirstId);
            var second = byCandidate.GetValueOrDefault(pair.SecondId);
            if (first is not null && second is not null)
            {
                plan.NearFile.Add(Math.Max(first.Line, second.Line));
            }
            else if (first is not null || second is not null)
            {
                var row = first ?? second!;
                var crmId = first is not null ? pair.SecondId : pair.FirstId;
                if (!plan.NearCrm.TryGetValue(row.Line, out var set))
                {
                    plan.NearCrm[row.Line] = set = [];
                }

                set.Add(crmId);
            }
        }
    }

    /// <summary>What this run holds that is not saved yet, so a later row sees it exactly as it would after the commit.</summary>
    private sealed class RunScope
    {
        public List<Organization> Organizations { get; } = [];
        public List<Contact> Contacts { get; } = [];

        public void Clear()
        {
            Organizations.Clear();
            Contacts.Clear();
        }
    }

    private sealed class RowResult
    {
        public string Action { get; set; } = ImportAction.Unchanged;
        public string? Reason { get; set; }
        public Guid? OrganizationId { get; set; }
        public Guid? ContactId { get; set; }
        public string? ContactAction { get; set; }
        public List<string> Fields { get; } = [];
        public List<string> Conflicts { get; } = [];
        public List<string> Warnings { get; } = [];
        public int ContactsWritten { get; set; }
        public List<(string Type, Guid Id, string Action, IReadOnlyList<string>? Fields)> Entities { get; } = [];
    }

    private async Task<RowResult> ProcessAsync(
        MigrationRowData row, Plan plan, RunScope scope, bool includeBilling, ISuppressionCheck suppressed, CancellationToken ct)
    {
        var result = new RowResult();
        result.Warnings.AddRange(row.Warnings);
        if (row.Rejected)
        {
            result.Action = ImportAction.Rejected;
            result.Reason = row.RejectCode;
            return result;
        }

        var match = await FindAsync(row, scope, ct);
        if (match.Ambiguous)
        {
            result.Action = ImportAction.Conflict;
            result.Reason = ImportReason.AmbiguousMatch;
            return result;
        }

        var details = DetailsOf(row);
        Organization organization;
        var created = false;
        if (match.Organization is { } existing)
        {
            organization = existing;
            result.Conflicts.AddRange(existing.FindConflicts(details, includeBilling, compareStatus: row.Status is not null));
            var filled = existing.FillGaps(details, includeBilling);
            result.Fields.AddRange(filled);
            if (filled.Count > 0)
            {
                scope.Organizations.Add(existing);
                result.Entities.Add((ImportRunEntity.OrganizationType, existing.Id, ImportAction.Updated, filled));
            }
        }
        else
        {
            var made = Organization.Create(details with { Status = row.Status ?? OrganizationStatus.Customer });
            if (!made.IsSuccess)
            {
                result.Action = ImportAction.Rejected;
                result.Reason = made.Error!.Code;
                return result;
            }

            organization = made.Value;
            created = true;
            db.Organizations.Add(organization);
            scope.Organizations.Add(organization);
            result.Entities.Add((ImportRunEntity.OrganizationType, organization.Id, ImportAction.Created, null));
        }

        result.OrganizationId = organization.Id;
        if (plan.NearFile.Contains(row.Line) || (plan.NearCrm.TryGetValue(row.Line, out var near) && near.Any(id => id != organization.Id)))
        {
            result.Warnings.Add(ImportReason.NearDuplicate);
        }

        await ApplyContactAsync(row, organization, created, scope, suppressed, result, ct);

        if (created)
        {
            result.Action = ImportAction.Created;
        }
        else if (result.Conflicts.Count > 0)
        {
            result.Action = ImportAction.Conflict;
            result.Reason = ImportReason.FieldConflict;
        }
        else
        {
            result.Action = result.Fields.Count > 0 || result.ContactsWritten > 0 ? ImportAction.Updated : ImportAction.Unchanged;
        }

        return result;
    }

    private static OrganizationDetails DetailsOf(MigrationRowData row)
    {
        var address = new Address(row.Street, row.PostalCode, row.City, "NO");
        return new OrganizationDetails(
            row.Name!,
            row.OrgNumber,
            null,
            row.Status ?? OrganizationStatus.Customer,
            null,
            row.Website,
            row.Phone,
            row.Email,
            row.InvoiceEmail,
            row.Ehf ?? false,
            row.OwnerId,
            null,
            address,
            address,
            address,
            row.Domain is null ? [] : [row.Domain]);
    }

    private sealed record Match(Organization? Organization, bool Ambiguous);

    /// <summary>BR-CUS-06 order: organization number, then a shared domain, then the exact name. A different number is a different company.</summary>
    private async Task<Match> FindAsync(MigrationRowData row, RunScope scope, CancellationToken ct)
    {
        if (row.OrgNumber is { } number)
        {
            var byNumber = scope.Organizations.FirstOrDefault(o => o.OrgNumber == number)
                           ?? await db.Organizations.SingleOrDefaultAsync(o => o.OrgNumber == number, ct);
            if (byNumber is not null)
            {
                return new Match(byNumber, false);
            }
        }

        bool Compatible(Organization o) => row.OrgNumber is null || o.OrgNumber is null || o.OrgNumber == row.OrgNumber;

        if (row.Domain is { } domain)
        {
            var inCrm = await db.Organizations.Where(o => o.Domains.Contains(domain)).Take(21).ToListAsync(ct);
            var candidates = inCrm.Concat(scope.Organizations.Where(o => o.Domains.Contains(domain))).DistinctBy(o => o.Id).Where(Compatible).ToList();
            if (candidates.Count == 1)
            {
                return new Match(candidates[0], false);
            }

            if (candidates.Count > 1)
            {
                return new Match(null, true);
            }
        }

        var name = row.Name!.Trim();
        var byName = (await db.Organizations.Where(o => o.Name == name).Take(21).ToListAsync(ct))
            .Concat(scope.Organizations.Where(o => string.Equals(o.Name, name, StringComparison.OrdinalIgnoreCase)))
            .DistinctBy(o => o.Id).Where(Compatible).ToList();
        return byName.Count switch
        {
            1 => new Match(byName[0], false),
            > 1 => new Match(null, true),
            _ => new Match(null, false),
        };
    }

    private async Task<Contact?> FindContactAsync(MigrationRowData row, Organization organization, bool organizationIsNew, RunScope scope, CancellationToken ct)
    {
        if (row.ContactEmail is { } email)
        {
            var byEmail = scope.Contacts.FirstOrDefault(c => c.Email == email)
                          ?? await db.Contacts.Include(c => c.Affiliations).FirstOrDefaultAsync(c => c.Email == email, ct);
            if (byEmail is not null)
            {
                return byEmail;
            }
        }

        if (organizationIsNew || (row.ContactFirstName is null && row.ContactLastName is null))
        {
            return null;
        }

        // Without an address the person is told apart by name among the organization's own contacts.
        var wanted = Contact.NameKey($"{row.ContactFirstName} {row.ContactLastName}");
        var organizationId = organization.Id;
        var own = await db.Contacts.Include(c => c.Affiliations).Where(c => c.Affiliations.Any(a => a.OrganizationId == organizationId)).ToListAsync(ct);
        return own.Concat(scope.Contacts.Where(c => c.Affiliations.Any(a => a.OrganizationId == organizationId)))
            .DistinctBy(c => c.Id)
            .FirstOrDefault(c => Contact.NameKey(c.FullName) == wanted && (row.ContactEmail is null || c.Email is null || c.Email == row.ContactEmail));
    }

    private async Task ApplyContactAsync(
        MigrationRowData row, Organization organization, bool organizationIsNew, RunScope scope, ISuppressionCheck suppressed, RowResult result, CancellationToken ct)
    {
        if (!row.HasContact)
        {
            return;
        }

        if (suppressed.IsSuppressed(row.ContactEmail, null))
        {
            // DEV-11: people erased at their request do not come back with an old system's file.
            result.Warnings.Add(ImportReason.ContactSuppressed);
            result.ContactAction = "Skipped";
            return;
        }

        var details = new ContactDetails(row.ContactFirstName ?? string.Empty, row.ContactLastName ?? string.Empty, row.ContactEmail, row.ContactPhone, null, null);
        var contact = await FindContactAsync(row, organization, organizationIsNew, scope, ct);
        var created = false;
        IReadOnlyList<string> filled = [];
        if (contact is null)
        {
            var made = Contact.Create(details);
            if (!made.IsSuccess)
            {
                // An address alone names nobody: the person is not invented under a placeholder name.
                result.Warnings.Add("CONTACT_NAME_MISSING");
                result.ContactAction = "Skipped";
                return;
            }

            contact = made.Value;
            created = true;
            db.Contacts.Add(contact);
            scope.Contacts.Add(contact);
            result.Entities.Add((ImportRunEntity.ContactType, contact.Id, ImportAction.Created, null));
        }
        else
        {
            result.Conflicts.AddRange(contact.FindConflicts(details).Select(c => $"contact.{c}"));
            filled = contact.FillGaps(details);
            if (filled.Count > 0)
            {
                scope.Contacts.Add(contact);
                result.Entities.Add((ImportRunEntity.ContactType, contact.Id, ImportAction.Updated, filled));
            }
        }

        var affiliationChanged = false;
        switch (contact.StateFor(organization.Id))
        {
            case AffiliationState.None:
            {
                var roles = row.ContactRoles != ContactRoles.None ? row.ContactRoles : ContactRoles.EndUser;
                var primary = organizationIsNew
                    ? !scope.Contacts.Any(c => c.Id != contact.Id && c.Affiliations.Any(a => a.OrganizationId == organization.Id && a.IsPrimary))
                    : !await HasPrimaryAsync(organization.Id, scope, ct);
                contact.Affiliate(organization.Id, new AffiliationDetails(row.ContactTitle, roles, IsPrimary: primary));
                scope.Contacts.Add(contact);
                affiliationChanged = true;
                var affiliation = contact.Affiliations.First(a => a.OrganizationId == organization.Id);
                result.Entities.Add((ImportRunEntity.AffiliationType, affiliation.Id, ImportAction.Created, null));
                break;
            }

            case AffiliationState.Active:
            {
                var changed = contact.FillAffiliationGaps(organization.Id, new AffiliationDetails(row.ContactTitle, row.ContactRoles, IsPrimary: false));
                if (changed.Count > 0)
                {
                    affiliationChanged = true;
                    scope.Contacts.Add(contact);
                    var affiliation = contact.Affiliations.First(a => a.OrganizationId == organization.Id);
                    result.Entities.Add((ImportRunEntity.AffiliationType, affiliation.Id, ImportAction.Updated, changed));
                }

                if (contact.AffiliationRoleConflicts(organization.Id, row.ContactRoles))
                {
                    result.Conflicts.Add("contact.roles");
                }

                break;
            }

            default:
                // Someone ended this affiliation in the CRM: the file does not bring it back.
                result.Conflicts.Add("contact.affiliation");
                break;
        }

        result.ContactId = contact.Id;
        result.ContactAction = created ? "Created" : filled.Count > 0 || affiliationChanged ? "Updated" : "Unchanged";
        if (created || filled.Count > 0 || affiliationChanged)
        {
            result.ContactsWritten++;
        }
    }

    private async Task<bool> HasPrimaryAsync(Guid organizationId, RunScope scope, CancellationToken ct) =>
        scope.Contacts.Any(c => c.Affiliations.Any(a => a.OrganizationId == organizationId && a.IsPrimary && a.IsActive)) ||
        await db.OrganizationContacts.AnyAsync(a => a.OrganizationId == organizationId && a.IsPrimary && a.IsActive, ct);
}
