using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.Identity.Contracts;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Organizations;

public sealed record DuplicateSide(
    Guid Id,
    string Name,
    string? OrgNumber,
    OrganizationStatus Status,
    string? City,
    string? Email,
    string? Phone,
    IReadOnlyList<string> Domains,
    int ActiveContacts,
    DateTimeOffset CreatedAt);

public sealed record DuplicatePairResponse(DuplicateSide First, DuplicateSide Second, IReadOnlyList<DuplicateReason> Reasons);

public sealed record DismissDuplicateRequest(Guid OrganizationId, Guid OtherOrganizationId);

public sealed record MergeRequest(Guid SourceOrganizationId);

public sealed record MergeResponse(Guid MergeId, Guid TargetOrganizationId, Guid SourceOrganizationId, int MovedContacts);

public sealed record MergeListItem(
    Guid Id,
    Guid TargetOrganizationId,
    string TargetName,
    Guid SourceOrganizationId,
    string SourceName,
    DateTimeOffset MergedAt,
    UserRefDto? MergedBy,
    DateTimeOffset? UndoneAt,
    bool CanUndo);

public sealed record FindDuplicates(Guid? OrganizationId);

public sealed record MergeOrganizations(Guid TargetId, Guid SourceId);

public sealed record UndoMerge(Guid MergeId);

internal static class MergeErrors
{
    public static Error SameOrganization => Error.Validation("CUS_MERGE_SAME", "An organization cannot be merged into itself.");

    public static Error DifferentOrgNumbers => Error.Conflict(
        "CUS_MERGE_DIFFERENT_ORGNR", "Both organizations have different organization numbers and are separate legal entities.");

    public static Error MergeNotFound(Guid id) => Error.NotFound("CUS_MERGE_NOT_FOUND", $"Merge {id} was not found.");

    public static Error UndoExpired => Error.Conflict("CUS_MERGE_UNDO_EXPIRED", "The merge is older than 30 days or already undone.");

    public static Error TargetChanged => Error.Conflict(
        "CUS_MERGE_TARGET_CHANGED",
        "The organization was changed or deleted after the merge. Undoing would overwrite those changes; correct the records manually.");
}

internal sealed class FindDuplicatesHandler(CustomersDbContext db) : IQueryHandler<FindDuplicates, IReadOnlyList<DuplicatePairResponse>>
{
    private const int MaxPairs = 200;

    public async Task<IReadOnlyList<DuplicatePairResponse>> HandleAsync(FindDuplicates query, CancellationToken cancellationToken)
    {
        // Loads a narrow projection of all organizations; fine for the planned volume (NFR-04: 5 000).
        var candidates = await db.Organizations.AsNoTracking()
            .Select(o => new DuplicateCandidate(o.Id, o.Name, o.OrgNumber, o.Email, o.Phone, o.Domains))
            .ToListAsync(cancellationToken);
        var dismissed = (await db.DuplicateDismissals.AsNoTracking()
                .Select(d => new { d.FirstOrganizationId, d.SecondOrganizationId })
                .ToListAsync(cancellationToken))
            .Select(d => (d.FirstOrganizationId, d.SecondOrganizationId))
            .ToHashSet();

        var pairs = DuplicateDetector.Find(candidates, dismissed)
            .Where(p => query.OrganizationId is not { } id || p.FirstId == id || p.SecondId == id)
            .Take(MaxPairs)
            .ToList();
        if (pairs.Count == 0)
        {
            return [];
        }

        var ids = pairs.SelectMany(p => new[] { p.FirstId, p.SecondId }).Distinct().ToList();
        var sides = await db.Organizations.AsNoTracking()
            .Where(o => ids.Contains(o.Id))
            .Select(o => new DuplicateSide(
                o.Id, o.Name, o.OrgNumber, o.Status, o.VisitAddress.City ?? o.PostalAddress.City, o.Email, o.Phone, o.Domains,
                db.OrganizationContacts.Count(a => a.OrganizationId == o.Id && a.IsActive), o.CreatedAt))
            .ToDictionaryAsync(o => o.Id, cancellationToken);

        return pairs.Select(p => new DuplicatePairResponse(sides[p.FirstId], sides[p.SecondId], p.Reasons)).ToList();
    }
}

internal sealed class DismissDuplicateHandler(CustomersDbContext db) : ICommandHandler<DismissDuplicateRequest, Result>
{
    public async Task<Result> HandleAsync(DismissDuplicateRequest command, CancellationToken cancellationToken)
    {
        if (command.OrganizationId == command.OtherOrganizationId)
        {
            return MergeErrors.SameOrganization;
        }

        var (first, second) = DuplicateDetector.PairKey(command.OrganizationId, command.OtherOrganizationId);
        if (await db.DuplicateDismissals.AnyAsync(d => d.FirstOrganizationId == first && d.SecondOrganizationId == second, cancellationToken))
        {
            return Result.Success();
        }

        var found = await db.Organizations.CountAsync(o => o.Id == first || o.Id == second, cancellationToken);
        if (found != 2)
        {
            return OrganizationErrors.NotFound(found == 0 || !await db.Organizations.AnyAsync(o => o.Id == first, cancellationToken) ? first : second);
        }

        db.DuplicateDismissals.Add(new DuplicateDismissal(first, second));
        await db.SaveChangesAsync(cancellationToken);
        return Result.Success();
    }
}

/// <summary>
/// Merges the source organization into the target (BR-CUS-06): fills the target's empty fields, moves contacts that are not
/// already on the target, soft-deletes the source and publishes <see cref="OrganizationsMerged"/> for other modules.
/// </summary>
internal sealed class MergeOrganizationsHandler(CustomersDbContext db) : ICommandHandler<MergeOrganizations, Result<MergeResponse>>
{
    public async Task<Result<MergeResponse>> HandleAsync(MergeOrganizations command, CancellationToken cancellationToken)
    {
        if (command.TargetId == command.SourceId)
        {
            return MergeErrors.SameOrganization;
        }

        var organizations = await db.Organizations
            .Where(o => o.Id == command.TargetId || o.Id == command.SourceId)
            .ToListAsync(cancellationToken);
        var target = organizations.SingleOrDefault(o => o.Id == command.TargetId);
        var source = organizations.SingleOrDefault(o => o.Id == command.SourceId);
        if (target is null || source is null)
        {
            return OrganizationErrors.NotFound(target is null ? command.TargetId : command.SourceId);
        }

        if (target.OrgNumber is not null && source.OrgNumber is not null && target.OrgNumber != source.OrgNumber)
        {
            return MergeErrors.DifferentOrgNumbers;
        }

        var sourceAffiliations = await db.OrganizationContacts.Where(a => a.OrganizationId == source.Id).ToListAsync(cancellationToken);
        var targetContactIds = await db.OrganizationContacts
            .Where(a => a.OrganizationId == target.Id)
            .Select(a => a.ContactId)
            .ToListAsync(cancellationToken);
        var toMove = sourceAffiliations.Where(a => !targetContactIds.Contains(a.ContactId)).ToList();
        var targetHasPrimary = await db.OrganizationContacts.AnyAsync(a => a.OrganizationId == target.Id && a.IsPrimary, cancellationToken);

        var merge = new OrganizationMerge(target.Id, source.Id, target.Snapshot(), source.Snapshot(), toMove.Select(a => a.Id).ToArray());
        var response = new MergeResponse(merge.Id, target.Id, source.Id, toMove.Count);

        // Two saves in one transaction: the source must release its org number before the target takes it (unique index).
        var strategy = db.Database.CreateExecutionStrategy();
        await strategy.ExecuteAsync(async () =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            source.MarkMergedInto(merge.Id, target.Id);
            foreach (var affiliation in toMove)
            {
                affiliation.MoveTo(target.Id);
                if (targetHasPrimary)
                {
                    affiliation.ClearPrimary();
                }
            }

            db.OrganizationMerges.Add(merge);
            await db.SaveChangesAsync(cancellationToken);

            target.AbsorbFrom(merge.SourceBefore);
            await db.SaveChangesAsync(cancellationToken);

            merge.RecordTargetVersion(target.ModifiedAt);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        });

        return response;
    }
}

internal sealed class UndoMergeHandler(CustomersDbContext db, TimeProvider timeProvider) : ICommandHandler<UndoMerge, Result>
{
    public async Task<Result> HandleAsync(UndoMerge command, CancellationToken cancellationToken)
    {
        var merge = await db.OrganizationMerges.SingleOrDefaultAsync(m => m.Id == command.MergeId, cancellationToken);
        if (merge is null)
        {
            return MergeErrors.MergeNotFound(command.MergeId);
        }

        var now = timeProvider.GetUtcNow();
        if (!merge.CanUndo(now))
        {
            return MergeErrors.UndoExpired;
        }

        var target = await db.Organizations.SingleOrDefaultAsync(o => o.Id == merge.TargetId, cancellationToken);
        var source = await db.Organizations.IgnoreQueryFilters().SingleOrDefaultAsync(o => o.Id == merge.SourceId, cancellationToken);
        // A change to the target after the merge (other than the merge itself) would be lost by restoring its snapshot.
        if (target is null || source is null || source.MergedIntoId != target.Id || target.ModifiedAt != merge.TargetModifiedAt)
        {
            return MergeErrors.TargetChanged;
        }

        var moved = await db.OrganizationContacts
            .Where(a => merge.MovedAffiliationIds.Contains(a.Id) && a.OrganizationId == target.Id)
            .ToListAsync(cancellationToken);

        var strategy = db.Database.CreateExecutionStrategy();
        await strategy.ExecuteAsync(async () =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
            target.Restore(merge.TargetBefore);
            foreach (var affiliation in moved)
            {
                affiliation.MoveTo(source.Id);
            }

            merge.MarkUndone(now);
            await db.SaveChangesAsync(cancellationToken);

            source.UndoMerge(merge.Id, merge.SourceBefore);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        });

        return Result.Success();
    }
}

internal sealed class ListMergesHandler(CustomersDbContext db, IUserDirectory users, TimeProvider timeProvider)
    : IQueryHandler<Unit, IReadOnlyList<MergeListItem>>
{
    public async Task<IReadOnlyList<MergeListItem>> HandleAsync(Unit query, CancellationToken cancellationToken)
    {
        var since = timeProvider.GetUtcNow() - OrganizationMerge.UndoWindow - TimeSpan.FromDays(30);
        var merges = await db.OrganizationMerges.AsNoTracking()
            .Where(m => m.CreatedAt >= since)
            .OrderByDescending(m => m.CreatedAt)
            .Take(50)
            .ToListAsync(cancellationToken);
        var orgIds = merges.SelectMany(m => new[] { m.TargetId, m.SourceId }).Distinct().ToList();
        var names = await db.Organizations.AsNoTracking().IgnoreQueryFilters()
            .Where(o => orgIds.Contains(o.Id))
            .ToDictionaryAsync(o => o.Id, o => o.Name, cancellationToken);
        var people = await users.GetUsersAsync(merges.Where(m => m.CreatedBy.HasValue).Select(m => m.CreatedBy!.Value).Distinct().ToList(), cancellationToken);
        var now = timeProvider.GetUtcNow();

        return merges.Select(m => new MergeListItem(
                m.Id,
                m.TargetId,
                names.GetValueOrDefault(m.TargetId, m.TargetBefore.Details.Name),
                m.SourceId,
                m.SourceBefore.Details.Name,
                m.CreatedAt,
                m.CreatedBy is { } by && people.TryGetValue(by, out var u) ? new UserRefDto(u.Id, u.DisplayName) : null,
                m.UndoneAt,
                m.CanUndo(now)))
            .ToList();
    }
}

/// <summary>Marker for queries without parameters.</summary>
public readonly record struct Unit;
