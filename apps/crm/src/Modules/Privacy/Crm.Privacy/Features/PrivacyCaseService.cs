using System.Globalization;
using System.Text;
using System.Text.Json;
using Crm.Infrastructure.Persistence;
using Crm.Privacy.Contracts;
using Crm.Privacy.Domain;
using Crm.Privacy.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Privacy.Features;

public sealed record OpenCaseRequest(PrivacyCaseKind Kind, DataSubjectKind SubjectKind, Guid SubjectId, RequestChannel Channel, DateTimeOffset? ReceivedAt, string? Note);

internal sealed class OpenCaseRequestValidator : AbstractValidator<OpenCaseRequest>
{
    public OpenCaseRequestValidator()
    {
        RuleFor(x => x.SubjectId).NotEmpty();
        RuleFor(x => x.Note).MaximumLength(500);
    }
}

public sealed record VerifyCaseRequest(VerificationMethod Method, string? Note);

internal sealed class VerifyCaseRequestValidator : AbstractValidator<VerifyCaseRequest>
{
    public VerifyCaseRequestValidator() => RuleFor(x => x.Note).MaximumLength(500);
}

public sealed record ExecuteCaseRequest(string PlanDigest, string Confirmation);

internal sealed class ExecuteCaseRequestValidator : AbstractValidator<ExecuteCaseRequest>
{
    public ExecuteCaseRequestValidator()
    {
        RuleFor(x => x.PlanDigest).NotEmpty().MaximumLength(64);
        RuleFor(x => x.Confirmation).NotEmpty().MaximumLength(32);
    }
}

public sealed record RejectCaseRequest(string Reason);

internal sealed class RejectCaseRequestValidator : AbstractValidator<RejectCaseRequest>
{
    public RejectCaseRequestValidator() => RuleFor(x => x.Reason).NotEmpty().MaximumLength(500);
}

public sealed record PrivacyCaseSummary(
    Guid Id, string Number, PrivacyCaseKind Kind, DataSubjectKind SubjectKind, Guid SubjectId, PrivacyCaseStatus Status,
    DateTimeOffset ReceivedAt, DateOnly DueOn, bool Overdue);

public sealed record PrivacyCaseResponse(
    Guid Id,
    string Number,
    PrivacyCaseKind Kind,
    DataSubjectKind SubjectKind,
    Guid SubjectId,
    PrivacyCaseStatus Status,
    RequestChannel Channel,
    DateTimeOffset ReceivedAt,
    DateOnly DueOn,
    bool Overdue,
    string? Note,
    DateTimeOffset? VerifiedAt,
    VerificationMethod? VerificationMethod,
    string? VerificationNote,
    string? PlanDigest,
    DateTimeOffset? PreviewedAt,
    DateTimeOffset? CompletedAt,
    string? RejectionReason,
    string? ExportSha256,
    JsonElement? Receipt,
    string Etag);

/// <summary>An erasure plan as the page shows it: the records with their fate, counted per module and action.</summary>
public sealed record PlanResponse(string Digest, IReadOnlyList<PlannedErasure> Records, IReadOnlyList<PlanCount> Counts, string Etag);

public sealed record PlanCount(string Module, ErasureAction Action, int Records);

/// <summary>An export file and the case's new version (the export is recorded on the case).</summary>
public sealed record ExportFile(byte[] Content, string FileName, string Sha256, string Etag);

internal static class PrivacyErrors
{
    public static Error NotFound(Guid id) => Error.NotFound("PRV_CASE_NOT_FOUND", $"Privacy case {id} does not exist.");

    public static readonly Error SubjectNotFound = Error.NotFound("PRV_SUBJECT_NOT_FOUND", "The person this case is about does not exist.");

    public static readonly Error InvalidETag = Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");

    public static readonly Error Closed = Error.Conflict("PRV_CASE_CLOSED", "The case is closed.");

    public static readonly Error NotVerified = Error.Conflict("PRV_CASE_NOT_VERIFIED", "The requester's identity has not been verified.");

    public static readonly Error WrongKind = Error.Conflict("PRV_CASE_WRONG_KIND", "This step does not belong to this kind of request.");

    public static readonly Error NotPreviewed = Error.Conflict("PRV_CASE_NOT_PREVIEWED", "Preview the erasure plan before carrying it out.");

    public static readonly Error PlanChanged = Error.Conflict(
        "PRV_PLAN_CHANGED", "The person's data changed since the plan was previewed. Preview the plan again and check it.");

    public static readonly Error ConfirmationMismatch = Error.Validation(
        "PRV_CONFIRMATION_MISMATCH", "Type the case number to confirm the erasure.");

    public static Error Incomplete(IEnumerable<string> modules) => Error.Conflict(
        "PRV_EXECUTION_INCOMPLETE",
        "Not every module could finish; what was done stays done. Carry the erasure out again to continue.",
        new Dictionary<string, object?> { ["modules"] = modules.ToList() });
}

/// <summary>
/// Data subject requests (DEV-11, ADR-020): a case is opened for a contact or a lead, the requester's identity is verified,
/// an access request is answered with an export of everything the modules hold, an erasure request with a previewed plan
/// carried out module by module — idempotent, resumable, keeping what bookkeeping or a legal hold requires — that leaves
/// suppressions behind and a manifest in the database and outside it.
/// </summary>
internal sealed class PrivacyCaseService(
    PrivacyDbContext db,
    IEnumerable<IDataSubjectResolver> resolvers,
    IEnumerable<IExternalReferenceSource> referenceSources,
    IEnumerable<IPersonalDataContributor> contributors,
    SuppressionHasher hasher,
    IDocumentStore store,
    ICurrentUser currentUser,
    TimeProvider time,
    ILogger<PrivacyCaseService> logger)
{
    public const string ManifestPrefix = "privacy/manifests/";

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    /// <summary>What every export says it does not contain, whichever modules contributed.</summary>
    internal static readonly IReadOnlyList<string> GlobalExclusions =
    [
        "Other people's data in the same records — the employees who made changes, other participants — is left out.",
        "Mail bodies, calendar entries and files stay in Microsoft 365; the CRM keeps only the references listed here.",
        "Atera and PowerOffice keep their own records of the person; what the CRM mirrors from them is included.",
        "Database backups keep earlier states until they expire; they are not searched.",
    ];

    public async Task<PagedResult<PrivacyCaseSummary>> ListAsync(bool includeClosed, int? limit, string? cursor, CancellationToken ct)
    {
        var today = Today();
        var query = db.Cases.AsNoTracking();
        if (!includeClosed)
        {
            query = query.Where(c => c.Status != PrivacyCaseStatus.Completed && c.Status != PrivacyCaseStatus.Rejected);
        }

        // Newest first, then id (DEV-12): a page per request and the count of all.
        var total = await query.CountAsync(ct);
        if (KeysetCursor.Decode(cursor) is { } after &&
            DateTimeOffset.TryParseExact(after.SortKey, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var received))
        {
            query = query.Where(c => c.ReceivedAt < received || (c.ReceivedAt == received && c.Id.CompareTo(after.Id) < 0));
        }

        var take = KeysetCursor.ClampLimit(limit);
        var page = await query.OrderByDescending(c => c.ReceivedAt).ThenByDescending(c => c.Id).Take(take + 1).ToListAsync(ct);
        var cases = page.Take(take).ToList();
        var next = page.Count > take ? new KeysetCursor(cases[^1].ReceivedAt.ToString("O", CultureInfo.InvariantCulture), cases[^1].Id).Encode() : null;
        return new PagedResult<PrivacyCaseSummary>(cases.Select(c => new PrivacyCaseSummary(
            c.Id, c.Number, c.Kind, c.SubjectKind, c.SubjectId, c.Status, c.ReceivedAt, c.DueOn, !c.IsClosed && c.DueOn < today)).ToList(), next, total);
    }

    public async Task<Result<PrivacyCaseResponse>> GetAsync(Guid id, CancellationToken ct) =>
        await db.Cases.SingleOrDefaultAsync(c => c.Id == id, ct) is { } privacyCase ? ToResponse(privacyCase) : PrivacyErrors.NotFound(id);

    public async Task<Result<PrivacyCaseResponse>> OpenAsync(OpenCaseRequest request, CancellationToken ct)
    {
        if (await ResolveAsync(request.SubjectKind, request.SubjectId, ct) is null)
        {
            return PrivacyErrors.SubjectNotFound;
        }

        var receivedAt = request.ReceivedAt ?? time.GetUtcNow();
        var receivedOn = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(receivedAt, Oslo).DateTime);
        var privacyCase = PrivacyCase.Open(
            await db.NextCaseNumberAsync(receivedOn.Year, ct), request.Kind, request.SubjectKind, request.SubjectId, request.Channel,
            receivedAt, receivedOn.AddMonths(1), Clean(request.Note));
        db.Cases.Add(privacyCase);
        await db.SaveChangesAsync(ct);
        return ToResponse(privacyCase);
    }

    public Task<Result<PrivacyCaseResponse>> VerifyAsync(Guid id, string ifMatch, VerifyCaseRequest request, CancellationToken ct) =>
        MutateAsync(id, ifMatch, privacyCase =>
        {
            if (privacyCase.IsClosed)
            {
                return PrivacyErrors.Closed;
            }

            privacyCase.Verify(request.Method, Clean(request.Note), currentUser.UserId, time.GetUtcNow());
            return Result.Success();
        }, ct);

    public Task<Result<PrivacyCaseResponse>> RejectAsync(Guid id, string ifMatch, RejectCaseRequest request, CancellationToken ct) =>
        MutateAsync(id, ifMatch, privacyCase =>
        {
            if (privacyCase.IsClosed || privacyCase.Status == PrivacyCaseStatus.Executing)
            {
                return PrivacyErrors.Closed;
            }

            privacyCase.Reject(request.Reason.Trim(), currentUser.UserId, time.GetUtcNow());
            return Result.Success();
        }, ct);

    /// <summary>Computes the erasure plan, records it on the case and returns it; previewing again replaces the plan.</summary>
    public async Task<Result<PlanResponse>> PreviewAsync(Guid id, string ifMatch, CancellationToken ct)
    {
        if (await db.Cases.SingleOrDefaultAsync(c => c.Id == id, ct) is not { } privacyCase)
        {
            return PrivacyErrors.NotFound(id);
        }

        if (!db.ApplyIfMatch(privacyCase, ifMatch))
        {
            return PrivacyErrors.InvalidETag;
        }

        if (privacyCase.Kind != PrivacyCaseKind.Erasure)
        {
            return PrivacyErrors.WrongKind;
        }

        if (privacyCase.IsClosed || privacyCase.Status == PrivacyCaseStatus.Executing)
        {
            return PrivacyErrors.Closed;
        }

        if (privacyCase.VerifiedAt is null)
        {
            return PrivacyErrors.NotVerified;
        }

        if (await SubjectAsync(privacyCase, ct) is not { } subject)
        {
            return PrivacyErrors.SubjectNotFound;
        }

        var plan = await PlanAsync(subject, ct);
        var json = PrivacyPlan.Serialize(plan);
        privacyCase.RecordPlan(json, PrivacyPlan.Digest(json), time.GetUtcNow());
        await db.SaveChangesAsync(ct);
        return new PlanResponse(privacyCase.PlanDigest!, plan, Counts(plan), db.GetETag(privacyCase));
    }

    /// <summary>The recorded plan, as previewed (the records with their fate), for a case that has one.</summary>
    public async Task<Result<PlanResponse>> GetPlanAsync(Guid id, CancellationToken ct)
    {
        if (await db.Cases.SingleOrDefaultAsync(c => c.Id == id, ct) is not { } privacyCase)
        {
            return PrivacyErrors.NotFound(id);
        }

        if (privacyCase.PlanJson is null)
        {
            return PrivacyErrors.NotPreviewed;
        }

        var plan = PrivacyPlan.Deserialize(privacyCase.PlanJson);
        return new PlanResponse(privacyCase.PlanDigest!, plan, Counts(plan), db.GetETag(privacyCase));
    }

    /// <summary>
    /// Everything the modules hold about the person (art. 15), with what each leaves out and why; answering an access request
    /// with it completes the case. The file is handed to the requester, never stored.
    /// </summary>
    public async Task<Result<ExportFile>> ExportAsync(Guid id, CancellationToken ct)
    {
        if (await db.Cases.SingleOrDefaultAsync(c => c.Id == id, ct) is not { } privacyCase)
        {
            return PrivacyErrors.NotFound(id);
        }

        if (privacyCase.Kind != PrivacyCaseKind.Access)
        {
            return PrivacyErrors.WrongKind;
        }

        if (privacyCase.Status == PrivacyCaseStatus.Rejected)
        {
            return PrivacyErrors.Closed;
        }

        if (privacyCase.VerifiedAt is null)
        {
            return PrivacyErrors.NotVerified;
        }

        if (await SubjectAsync(privacyCase, ct) is not { } subject)
        {
            return PrivacyErrors.SubjectNotFound;
        }

        var sections = new List<PersonalDataSection>();
        foreach (var contributor in contributors.OrderBy(c => c.Module, StringComparer.Ordinal))
        {
            sections.Add(await contributor.ExportAsync(subject, ct));
        }

        var generatedAt = time.GetUtcNow();
        var document = new
        {
            @case = privacyCase.Number,
            generatedAt,
            subject = new { kind = subject.Kind, id = subject.Id },
            sections,
            excluded = GlobalExclusions,
            manifest = new
            {
                sections = sections.Select(s => new { module = s.Module, items = s.Items.Count, excluded = s.Excluded.Count }).ToList(),
                items = sections.Sum(s => s.Items.Count),
            },
        };
        var content = JsonSerializer.SerializeToUtf8Bytes(document, PrivacyPlan.IndentedJson);
        var sha = DocumentHashes.Sha256(content);
        privacyCase.RecordExport(sha, currentUser.UserId, generatedAt);
        await db.SaveChangesAsync(ct);
        return new ExportFile(content, $"{privacyCase.Number}-export.json", sha, db.GetETag(privacyCase));
    }

    /// <summary>
    /// Carries out the previewed plan (DEV-11-AC02/03). The plan must be the one previewed and the data unchanged since; each
    /// module erases its part in its own transaction and a failing module leaves the case Executing — carrying it out again
    /// continues with the recorded plan, and modules already done do nothing a second time. When every module is done:
    /// suppressions, the manifest (database and document store) and the receipt.
    /// </summary>
    public async Task<Result<PrivacyCaseResponse>> ExecuteAsync(Guid id, string ifMatch, ExecuteCaseRequest request, CancellationToken ct)
    {
        if (await db.Cases.SingleOrDefaultAsync(c => c.Id == id, ct) is not { } privacyCase)
        {
            return PrivacyErrors.NotFound(id);
        }

        if (!db.ApplyIfMatch(privacyCase, ifMatch))
        {
            return PrivacyErrors.InvalidETag;
        }

        if (privacyCase.Kind != PrivacyCaseKind.Erasure)
        {
            return PrivacyErrors.WrongKind;
        }

        if (privacyCase.IsClosed)
        {
            return PrivacyErrors.Closed;
        }

        if (privacyCase.Status is not (PrivacyCaseStatus.Previewed or PrivacyCaseStatus.Executing) || privacyCase.PlanJson is null)
        {
            return PrivacyErrors.NotPreviewed;
        }

        if (!string.Equals(request.Confirmation.Trim(), privacyCase.Number, StringComparison.OrdinalIgnoreCase))
        {
            return PrivacyErrors.ConfirmationMismatch;
        }

        if (!string.Equals(request.PlanDigest, privacyCase.PlanDigest, StringComparison.Ordinal))
        {
            return PrivacyErrors.PlanChanged;
        }

        var subject = await SubjectAsync(privacyCase, ct);
        if (privacyCase.Status == PrivacyCaseStatus.Previewed)
        {
            // The person approved this plan: anything that appeared or changed since makes it a different plan.
            if (subject is null || PrivacyPlan.Digest(PrivacyPlan.Serialize(await PlanAsync(subject, ct))) != privacyCase.PlanDigest)
            {
                return PrivacyErrors.PlanChanged;
            }

            privacyCase.StartExecution();
            await db.SaveChangesAsync(ct);
        }

        // Resuming: a deleted lead no longer resolves; the modules work from the recorded plan's ids.
        subject ??= new DataSubject(privacyCase.SubjectKind, privacyCase.SubjectId, SubjectRecord(privacyCase), [], [], [], []);
        var plan = PrivacyPlan.Deserialize(privacyCase.PlanJson);
        var erased = new List<ErasedRecord>();
        var failed = new List<string>();
        foreach (var contributor in contributors.OrderBy(c => c.Module, StringComparer.Ordinal))
        {
            var part = plan.Where(p => p.Record.Module == contributor.Module).ToList();
            if (part.Count == 0)
            {
                continue;
            }

            try
            {
                erased.AddRange(await contributor.EraseAsync(subject, part, privacyCase.Number, ct));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Only the type: messages can quote the data being erased.
                logger.LogError("Privacy case {Case}: module {Module} could not erase its part ({Error}).", privacyCase.Number, contributor.Module, ex.GetType().Name);
                failed.Add(contributor.Module);
            }
        }

        if (failed.Count > 0)
        {
            return PrivacyErrors.Incomplete(failed);
        }

        var executedAt = time.GetUtcNow();
        var suppressions = await SuppressAsync(privacyCase, subject, ct);
        var (manifest, document) = await RecordManifestAsync(privacyCase, plan, erased, suppressions, executedAt, ct);
        privacyCase.CompleteErasure(ManifestContent.Receipt(document, manifest.Sha256), currentUser.UserId, executedAt);
        await db.SaveChangesAsync(ct);
        await StoreManifestAsync(manifest, ct);
        return ToResponse(privacyCase);
    }

    /// <summary>Writes a manifest to the document store once; a manifest that could not be written is retried by the replay job.</summary>
    internal async Task StoreManifestAsync(ErasureManifest manifest, CancellationToken ct)
    {
        if (manifest.StoredAt is not null)
        {
            return;
        }

        try
        {
            var key = ManifestKey(await hasher.InstallationAsync(ct), manifest.Id);
            await store.PutAsync(key, Encoding.UTF8.GetBytes(manifest.ContentJson), "application/json", ct);
            manifest.MarkStored(key, time.GetUtcNow());
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException and not DbUpdateException)
        {
            logger.LogWarning("Deletion manifest {Manifest} of case {Case} could not be written to the document store yet ({Error}).",
                manifest.Id, manifest.CaseNumber, ex.GetType().Name);
        }
    }

    /// <summary>
    /// Manifests live in a folder of their installation: a document store that outlives its database, or serves another one,
    /// never makes this database replay erasures it did not make.
    /// </summary>
    internal static string ManifestFolder(string installation) => $"{ManifestPrefix}{installation}/";

    internal static string ManifestKey(string installation, Guid manifestId) => $"{ManifestFolder(installation)}{manifestId:N}.json";

    private async Task<IReadOnlyList<PlannedErasure>> PlanAsync(DataSubject subject, CancellationToken ct)
    {
        var plan = new List<PlannedErasure>();
        foreach (var contributor in contributors)
        {
            plan.AddRange(await contributor.PlanAsync(subject, ct));
        }

        // A legal hold keeps its record whatever the module planned (DEV-11-AC04) — the record, not the person.
        var today = Today();
        var holds = await db.LegalHolds.AsNoTracking().Where(h => h.ReleasedAt == null && h.Until >= today).ToListAsync(ct);
        var held = holds.GroupBy(h => (h.Module, h.EntityType, h.EntityId)).ToDictionary(g => g.Key, g => g.MaxBy(h => h.Until)!);
        return PrivacyPlan.Canonical(plan.Select(p =>
            p.Action != ErasureAction.Retain && held.TryGetValue((p.Record.Module, p.Record.EntityType, p.Record.EntityId), out var hold)
                ? p with { Action = ErasureAction.Retain, Basis = RetentionBasis.LegalHold, RetainUntil = hold.Until, Note = hold.Explanation }
                : p));
    }

    private async Task<DataSubject?> SubjectAsync(PrivacyCase privacyCase, CancellationToken ct) =>
        await ResolveAsync(privacyCase.SubjectKind, privacyCase.SubjectId, ct);

    private async Task<DataSubject?> ResolveAsync(DataSubjectKind kind, Guid id, CancellationToken ct)
    {
        if (resolvers.SingleOrDefault(r => r.Kind == kind) is not { } resolver || await resolver.ResolveAsync(id, ct) is not { } subject)
        {
            return null;
        }

        var references = new List<ExternalReference>(subject.ExternalReferences);
        foreach (var source in referenceSources)
        {
            references.AddRange(await source.ReferencesAsync(subject, ct));
        }

        return subject with { ExternalReferences = references.Distinct().ToList() };
    }

    private async Task<IReadOnlyList<Suppression>> SuppressAsync(PrivacyCase privacyCase, DataSubject subject, CancellationToken ct)
    {
        var wanted = new List<(SuppressionKind Kind, string Value)>();
        foreach (var email in subject.Emails.Where(e => !string.IsNullOrWhiteSpace(e)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            wanted.Add((SuppressionKind.Email, await hasher.HashEmailAsync(email, ct)));
        }

        wanted.AddRange(subject.ExternalReferences.Select(r => (SuppressionKind.ExternalReference, r.ToString())));
        var result = new List<Suppression>();
        foreach (var (kind, value) in wanted.Distinct())
        {
            var existing = await db.Suppressions.SingleOrDefaultAsync(s => s.Kind == kind && s.Value == value && s.LiftedAt == null, ct);
            if (existing is null)
            {
                existing = Suppression.For(kind, value, privacyCase.Id);
                db.Suppressions.Add(existing);
            }

            result.Add(existing);
        }

        return result;
    }

    private async Task<(ErasureManifest Manifest, ManifestContent.Document Document)> RecordManifestAsync(
        PrivacyCase privacyCase, IReadOnlyList<PlannedErasure> plan, IReadOnlyList<ErasedRecord> erased,
        IReadOnlyList<Suppression> suppressions, DateTimeOffset executedAt, CancellationToken ct)
    {
        if (await db.ErasureManifests.SingleOrDefaultAsync(m => m.CaseId == privacyCase.Id, ct) is { } existing)
        {
            return (existing, ManifestContent.Parse(existing.ContentJson)!);
        }

        var manifestId = Crm.SharedKernel.Domain.SequentialId.New();
        var content = ManifestContent.Create(manifestId, await hasher.InstallationAsync(ct), privacyCase, plan, erased, suppressions, executedAt);
        var manifest = ErasureManifest.Record(manifestId, privacyCase.Id, privacyCase.Number, executedAt, content.Json, content.Sha256);
        db.ErasureManifests.Add(manifest);
        var document = ManifestContent.Parse(content.Json)!;
        db.ErasedRecords.AddRange(ErasedRows(manifest.Id, document.Records));
        return (manifest, document);
    }

    internal static IEnumerable<ErasedRecordRow> ErasedRows(Guid manifestId, IEnumerable<ErasedRecord> records) =>
        records.Where(e => e.Action != ErasureAction.Retain).DistinctBy(e => e.Record).Select(e => new ErasedRecordRow
        {
            ManifestId = manifestId,
            Module = e.Record.Module,
            EntityType = e.Record.EntityType,
            EntityId = e.Record.EntityId,
            Action = e.Action.ToString(),
            DataClass = e.DataClass,
        });

    private static List<PlanCount> Counts(IReadOnlyList<PlannedErasure> plan) =>
        plan.GroupBy(p => (p.Record.Module, p.Action))
            .OrderBy(g => g.Key.Module, StringComparer.Ordinal).ThenBy(g => g.Key.Action)
            .Select(g => new PlanCount(g.Key.Module, g.Key.Action, g.Count()))
            .ToList();

    private async Task<Result<PrivacyCaseResponse>> MutateAsync(Guid id, string ifMatch, Func<PrivacyCase, Result> change, CancellationToken ct)
    {
        if (await db.Cases.SingleOrDefaultAsync(c => c.Id == id, ct) is not { } privacyCase)
        {
            return PrivacyErrors.NotFound(id);
        }

        if (!db.ApplyIfMatch(privacyCase, ifMatch))
        {
            return PrivacyErrors.InvalidETag;
        }

        var changed = change(privacyCase);
        if (!changed.IsSuccess)
        {
            return changed.Error!;
        }

        await db.SaveChangesAsync(ct);
        return ToResponse(privacyCase);
    }

    private PrivacyCaseResponse ToResponse(PrivacyCase c) => new(
        c.Id, c.Number, c.Kind, c.SubjectKind, c.SubjectId, c.Status, c.Channel, c.ReceivedAt, c.DueOn, !c.IsClosed && c.DueOn < Today(),
        c.Note, c.VerifiedAt, c.VerificationMethod, c.VerificationNote, c.PlanDigest, c.PreviewedAt, c.CompletedAt, c.RejectionReason,
        c.ExportSha256, c.ReceiptJson is null ? null : JsonDocument.Parse(c.ReceiptJson).RootElement.Clone(), db.GetETag(c));

    internal static RecordRef SubjectRecord(PrivacyCase privacyCase) => privacyCase.SubjectKind == DataSubjectKind.Contact
        ? new RecordRef("customers", "Contact", privacyCase.SubjectId)
        : new RecordRef("sales", "Lead", privacyCase.SubjectId);

    private DateOnly Today() => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);

    private static string? Clean(string? text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();
}
