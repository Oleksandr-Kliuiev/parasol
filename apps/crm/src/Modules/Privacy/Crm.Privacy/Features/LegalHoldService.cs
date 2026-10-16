using System.Globalization;
using Crm.Infrastructure.Persistence;
using Crm.Privacy.Domain;
using Crm.Privacy.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Privacy.Features;

public sealed record PlaceHoldRequest(string Module, string EntityType, Guid EntityId, LegalHoldReason Reason, string Explanation, DateOnly Until);

internal sealed class PlaceHoldRequestValidator : AbstractValidator<PlaceHoldRequest>
{
    public PlaceHoldRequestValidator()
    {
        RuleFor(x => x.Module).NotEmpty().MaximumLength(64);
        RuleFor(x => x.EntityType).NotEmpty().MaximumLength(128);
        RuleFor(x => x.EntityId).NotEmpty();
        RuleFor(x => x.Explanation).NotEmpty().MaximumLength(1000);
    }
}

public sealed record ReleaseRequest(string Reason);

internal sealed class ReleaseRequestValidator : AbstractValidator<ReleaseRequest>
{
    public ReleaseRequestValidator() => RuleFor(x => x.Reason).NotEmpty().MaximumLength(500);
}

public sealed record LegalHoldResponse(
    Guid Id, string Module, string EntityType, Guid EntityId, LegalHoldReason Reason, string Explanation, DateOnly Until,
    bool Active, DateTimeOffset PlacedAt, DateTimeOffset? ReleasedAt, string? ReleaseReason, string Etag);

public sealed record SuppressionResponse(Guid Id, SuppressionKind Kind, Guid CaseId, string? CaseNumber, DateTimeOffset CreatedAt, DateTimeOffset? LiftedAt, string? LiftReason, string Etag);

/// <summary>
/// Legal holds (DEV-11-AC04) and lifting a suppression (AC05): both are decisions a person takes with a reason, kept with the
/// case history; neither ever deletes anything.
/// </summary>
internal sealed class LegalHoldService(PrivacyDbContext db, ICurrentUser currentUser, TimeProvider time)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task<PagedResult<LegalHoldResponse>> ListAsync(bool includeEnded, int? limit, string? cursor, CancellationToken ct)
    {
        var today = Today();
        var query = db.LegalHolds.Where(h => includeEnded || (h.ReleasedAt == null && h.Until >= today));
        // Newest first, then id (DEV-12). Tracked: the answer carries each hold's ETag for its release.
        var total = await query.CountAsync(ct);
        if (KeysetCursor.Decode(cursor) is { } after &&
            DateTimeOffset.TryParseExact(after.SortKey, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var created))
        {
            query = query.Where(h => h.CreatedAt < created || (h.CreatedAt == created && h.Id.CompareTo(after.Id) < 0));
        }

        var take = KeysetCursor.ClampLimit(limit);
        var page = await query.OrderByDescending(h => h.CreatedAt).ThenByDescending(h => h.Id).Take(take + 1).ToListAsync(ct);
        var holds = page.Take(take).ToList();
        var next = page.Count > take ? new KeysetCursor(holds[^1].CreatedAt.ToString("O", CultureInfo.InvariantCulture), holds[^1].Id).Encode() : null;
        return new PagedResult<LegalHoldResponse>(holds.Select(ToResponse).ToList(), next, total);
    }

    public async Task<Result<LegalHoldResponse>> PlaceAsync(PlaceHoldRequest request, CancellationToken ct)
    {
        if (request.Until < Today())
        {
            return Error.Validation("PRV_HOLD_IN_PAST", "A hold must end today or later.");
        }

        var hold = LegalHold.Place(request.Module.Trim(), request.EntityType.Trim(), request.EntityId, request.Reason, request.Explanation.Trim(), request.Until);
        db.LegalHolds.Add(hold);
        await db.SaveChangesAsync(ct);
        return ToResponse(hold);
    }

    public async Task<Result<LegalHoldResponse>> ReleaseAsync(Guid id, string ifMatch, ReleaseRequest request, CancellationToken ct)
    {
        if (await db.LegalHolds.SingleOrDefaultAsync(h => h.Id == id, ct) is not { } hold)
        {
            return Error.NotFound("PRV_HOLD_NOT_FOUND", $"Legal hold {id} does not exist.");
        }

        if (!db.ApplyIfMatch(hold, ifMatch))
        {
            return PrivacyErrors.InvalidETag;
        }

        if (hold.ReleasedAt is not null)
        {
            return Error.Conflict("PRV_HOLD_RELEASED", "The hold was already released.");
        }

        hold.Release(request.Reason.Trim(), currentUser.UserId, time.GetUtcNow());
        await db.SaveChangesAsync(ct);
        return ToResponse(hold);
    }

    public async Task<PagedResult<SuppressionResponse>> SuppressionsAsync(int? limit, string? cursor, CancellationToken ct)
    {
        IQueryable<Suppression> query = db.Suppressions;
        var total = await query.CountAsync(ct);
        if (KeysetCursor.Decode(cursor) is { } after &&
            DateTimeOffset.TryParseExact(after.SortKey, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var created))
        {
            query = query.Where(s => s.CreatedAt < created || (s.CreatedAt == created && s.Id.CompareTo(after.Id) < 0));
        }

        var take = KeysetCursor.ClampLimit(limit);
        var page = await query.OrderByDescending(s => s.CreatedAt).ThenByDescending(s => s.Id).Take(take + 1).ToListAsync(ct);
        var suppressions = page.Take(take).ToList();
        var next = page.Count > take
            ? new KeysetCursor(suppressions[^1].CreatedAt.ToString("O", CultureInfo.InvariantCulture), suppressions[^1].Id).Encode()
            : null;
        var caseIds = suppressions.Select(s => s.CaseId).Distinct().ToList();
        var numbers = await db.Cases.AsNoTracking().Where(c => caseIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, c => c.Number, ct);
        return new PagedResult<SuppressionResponse>(suppressions.Select(s => new SuppressionResponse(
            s.Id, s.Kind, s.CaseId, numbers.GetValueOrDefault(s.CaseId), s.CreatedAt, s.LiftedAt, s.LiftReason, db.GetETag(s))).ToList(), next, total);
    }

    /// <summary>A new lawful basis (the person became a customer again, gave consent): the external systems may bring them back.</summary>
    public async Task<Result<SuppressionResponse>> LiftAsync(Guid id, string ifMatch, ReleaseRequest request, CancellationToken ct)
    {
        if (await db.Suppressions.SingleOrDefaultAsync(s => s.Id == id, ct) is not { } suppression)
        {
            return Error.NotFound("PRV_SUPPRESSION_NOT_FOUND", $"Suppression {id} does not exist.");
        }

        if (!db.ApplyIfMatch(suppression, ifMatch))
        {
            return PrivacyErrors.InvalidETag;
        }

        if (suppression.LiftedAt is not null)
        {
            return Error.Conflict("PRV_SUPPRESSION_LIFTED", "The suppression was already lifted.");
        }

        suppression.Lift(request.Reason.Trim(), currentUser.UserId, time.GetUtcNow());
        await db.SaveChangesAsync(ct);
        var number = await db.Cases.AsNoTracking().Where(c => c.Id == suppression.CaseId).Select(c => c.Number).SingleOrDefaultAsync(ct);
        return new SuppressionResponse(suppression.Id, suppression.Kind, suppression.CaseId, number, suppression.CreatedAt, suppression.LiftedAt, suppression.LiftReason, db.GetETag(suppression));
    }

    private LegalHoldResponse ToResponse(LegalHold h) => new(
        h.Id, h.Module, h.EntityType, h.EntityId, h.Reason, h.Explanation, h.Until, h.IsActiveOn(Today()), h.CreatedAt, h.ReleasedAt, h.ReleaseReason,
        db.GetETag(h));

    private DateOnly Today() => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
}
