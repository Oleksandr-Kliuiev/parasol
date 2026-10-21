using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Organizations;

public sealed record Versioned<T>(T Value, string Etag);

public sealed record ListOrganizations(
    string? Search,
    OrganizationStatus? Status,
    Guid? AccountManagerId,
    string? Cursor,
    int? Limit);

public sealed record GetOrganization(Guid Id);

public sealed record CreateOrganization(OrganizationRequest Request);

public sealed record UpdateOrganization(Guid Id, OrganizationRequest Request, string IfMatch);

public sealed record DeleteOrganization(Guid Id);

public sealed record SetOrganizationParent(Guid Id, SetParentRequest Request, string IfMatch);

internal static class OrganizationErrors
{
    public static Error NotFound(Guid id) => Error.NotFound("CUS_ORGANIZATION_NOT_FOUND", $"Organization {id} was not found.");

    public static Error DuplicateOrgNumber(Guid existingId) => Error.Conflict(
        "CUS_DUPLICATE_ORGNR",
        "An organization with this organization number already exists.",
        new Dictionary<string, object?> { ["existingId"] = existingId });

    public static Error Merged(Guid id, Guid targetId) => new(
        "CUS_ORGANIZATION_MERGED",
        $"Organization {id} was merged into {targetId}.",
        ErrorType.NotFound,
        new Dictionary<string, object?> { ["mergedIntoId"] = targetId });

    public static Error InvalidETag => Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");

    public static Error ParentCycle => Error.Validation(
        "CUS_PARENT_CYCLE", "That organization is already below this one in the group; the group would loop.");
}

internal sealed class ListOrganizationsHandler(CustomersDbContext db, IUserDirectory users)
    : IQueryHandler<ListOrganizations, PagedResult<OrganizationListItem>>
{
    public async Task<PagedResult<OrganizationListItem>> HandleAsync(ListOrganizations query, CancellationToken cancellationToken)
    {
        var limit = KeysetCursor.ClampLimit(query.Limit);
        var organizations = db.Organizations.AsNoTracking().ApplyFilters(query.Search, query.Status, query.AccountManagerId);
        // How many the filter matches, counted before the page (DEV-12): the list's status filters show it.
        var total = await organizations.CountAsync(cancellationToken);

        if (KeysetCursor.Decode(query.Cursor) is { } cursor)
        {
            organizations = organizations.Where(o =>
                o.Name.CompareTo(cursor.SortKey) > 0 || (o.Name == cursor.SortKey && o.Id.CompareTo(cursor.Id) > 0));
        }

        var page = await organizations
            .OrderBy(o => o.Name).ThenBy(o => o.Id)
            .Take(limit + 1)
            .Select(o => new
            {
                o.Id, o.Name, o.OrgNumber, o.Status, VisitCity = o.VisitAddress.City, PostalCity = o.PostalAddress.City,
                o.AccountManagerId, o.RegistryStatus,
            })
            .ToListAsync(cancellationToken);

        var hasMore = page.Count > limit;
        var items = page.Take(limit).ToList();
        var managers = await users.GetUsersAsync(
            items.Where(i => i.AccountManagerId.HasValue).Select(i => i.AccountManagerId!.Value).Distinct().ToList(), cancellationToken);

        var result = items.Select(o => new OrganizationListItem(
                o.Id, o.Name, o.OrgNumber, o.Status, o.VisitCity ?? o.PostalCity,
                o.AccountManagerId is { } id && managers.TryGetValue(id, out var m) ? new UserRefDto(m.Id, m.DisplayName) : null,
                o.RegistryStatus))
            .ToList();

        var last = items.LastOrDefault();
        return new PagedResult<OrganizationListItem>(result, hasMore && last is not null ? new KeysetCursor(last.Name, last.Id).Encode() : null, total);
    }
}

internal sealed class GetOrganizationHandler(CustomersDbContext db, IUserDirectory users)
    : IQueryHandler<GetOrganization, Result<Versioned<OrganizationResponse>>>
{
    public async Task<Result<Versioned<OrganizationResponse>>> HandleAsync(GetOrganization query, CancellationToken cancellationToken)
    {
        // Tracked on purpose: the ETag is read from the RowVersion shadow property.
        var organization = await db.Organizations.SingleOrDefaultAsync(o => o.Id == query.Id, cancellationToken);
        if (organization is null)
        {
            var mergedInto = await db.Organizations.IgnoreQueryFilters().AsNoTracking()
                .Where(o => o.Id == query.Id && o.MergedIntoId != null)
                .Select(o => o.MergedIntoId)
                .SingleOrDefaultAsync(cancellationToken);
            return mergedInto is { } targetId ? OrganizationErrors.Merged(query.Id, targetId) : OrganizationErrors.NotFound(query.Id);
        }

        return new Versioned<OrganizationResponse>(
            await organization.ToResponseAsync(users, db, cancellationToken), db.GetETag(organization));
    }
}

internal sealed class CreateOrganizationHandler(CustomersDbContext db, IUserDirectory users)
    : ICommandHandler<CreateOrganization, Result<Versioned<OrganizationResponse>>>
{
    public async Task<Result<Versioned<OrganizationResponse>>> HandleAsync(CreateOrganization command, CancellationToken cancellationToken)
    {
        var created = Organization.Create(command.Request.ToDetails());
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        var organization = created.Value;
        if (await db.FindDuplicateAsync(organization.OrgNumber, null, cancellationToken) is { } duplicateId)
        {
            return OrganizationErrors.DuplicateOrgNumber(duplicateId);
        }

        db.Organizations.Add(organization);
        await db.SaveChangesAsync(cancellationToken);
        return new Versioned<OrganizationResponse>(await organization.ToResponseAsync(users, db, cancellationToken), db.GetETag(organization));
    }
}

internal sealed class UpdateOrganizationHandler(CustomersDbContext db, IUserDirectory users, Microsoft.Extensions.Options.IOptions<CustomersOptions> options)
    : ICommandHandler<UpdateOrganization, Result<Versioned<OrganizationResponse>>>
{
    public async Task<Result<Versioned<OrganizationResponse>>> HandleAsync(UpdateOrganization command, CancellationToken cancellationToken)
    {
        var organization = await db.Organizations.SingleOrDefaultAsync(o => o.Id == command.Id, cancellationToken);
        if (organization is null)
        {
            return OrganizationErrors.NotFound(command.Id);
        }

        if (!db.ApplyIfMatch(organization, command.IfMatch))
        {
            return OrganizationErrors.InvalidETag;
        }

        var details = command.Request.ToDetails();
        if (options.Value.BillingDetailsMaster == BillingDetailsMaster.PowerOffice)
        {
            details = organization.WithBillingDetailsOf(details);
        }

        var updated = organization.Update(details);
        if (!updated.IsSuccess)
        {
            return updated.Error!;
        }

        if (await db.FindDuplicateAsync(organization.OrgNumber, organization.Id, cancellationToken) is { } duplicateId)
        {
            return OrganizationErrors.DuplicateOrgNumber(duplicateId);
        }

        await db.SaveChangesAsync(cancellationToken);
        return new Versioned<OrganizationResponse>(await organization.ToResponseAsync(users, db, cancellationToken), db.GetETag(organization));
    }
}

/// <summary>
/// Places an organization under a group parent (FR-CUS-07). The group is a tree: a parent may not sit below its own child,
/// and "billed through the parent" is what makes the parent's basis collect this organization's lines (BR-BIL-12).
/// </summary>
internal sealed class SetOrganizationParentHandler(CustomersDbContext db, IUserDirectory users)
    : ICommandHandler<SetOrganizationParent, Result<Versioned<OrganizationResponse>>>
{
    public async Task<Result<Versioned<OrganizationResponse>>> HandleAsync(SetOrganizationParent command, CancellationToken cancellationToken)
    {
        var organization = await db.Organizations.SingleOrDefaultAsync(o => o.Id == command.Id, cancellationToken);
        if (organization is null)
        {
            return OrganizationErrors.NotFound(command.Id);
        }

        if (!db.ApplyIfMatch(organization, command.IfMatch))
        {
            return OrganizationErrors.InvalidETag;
        }

        if (command.Request.ParentId is { } parentId)
        {
            if (!await db.Organizations.AnyAsync(o => o.Id == parentId, cancellationToken))
            {
                return OrganizationErrors.NotFound(parentId);
            }

            if (await WouldLoopAsync(parentId, organization.Id, cancellationToken))
            {
                return OrganizationErrors.ParentCycle;
            }
        }

        var applied = organization.SetParent(command.Request.ParentId, command.Request.BilledThroughParent);
        if (!applied.IsSuccess)
        {
            return applied.Error!;
        }

        await db.SaveChangesAsync(cancellationToken);
        return new Versioned<OrganizationResponse>(await organization.ToResponseAsync(users, db, cancellationToken), db.GetETag(organization));
    }

    /// <summary>True when the candidate parent already has the organization above it.</summary>
    private async Task<bool> WouldLoopAsync(Guid parentId, Guid organizationId, CancellationToken ct)
    {
        var current = (Guid?)parentId;
        for (var step = 0; step < 10 && current is { } id; step++)
        {
            if (id == organizationId)
            {
                return true;
            }

            current = await db.Organizations.AsNoTracking().Where(o => o.Id == id).Select(o => o.ParentId).SingleOrDefaultAsync(ct);
        }

        return false;
    }
}

internal sealed class DeleteOrganizationHandler(CustomersDbContext db) : ICommandHandler<DeleteOrganization, Result>
{
    public async Task<Result> HandleAsync(DeleteOrganization command, CancellationToken cancellationToken)
    {
        var organization = await db.Organizations.SingleOrDefaultAsync(o => o.Id == command.Id, cancellationToken);
        if (organization is null)
        {
            return OrganizationErrors.NotFound(command.Id);
        }

        organization.MarkDeleted();
        await db.SaveChangesAsync(cancellationToken);
        return Result.Success();
    }
}

internal static class OrganizationQueries
{
    /// <summary>Filters shared by the list and the Excel export, so both always return the same rows.</summary>
    public static IQueryable<Organization> ApplyFilters(this IQueryable<Organization> organizations, string? search, OrganizationStatus? status, Guid? accountManagerId)
    {
        if (!string.IsNullOrWhiteSpace(search))
        {
            var term = search.Trim();
            var digits = OrgNumber.Normalize(term);
            var domain = term.TrimStart('@').ToLowerInvariant();
            organizations = digits.Length > 0 && digits.All(char.IsAsciiDigit)
                ? organizations.Where(o => o.OrgNumber != null && o.OrgNumber.StartsWith(digits))
                : organizations.Where(o => o.Name.Contains(term) || (o.Email != null && o.Email.Contains(term)) || o.Domains.Contains(domain));
        }

        if (status is { } s)
        {
            organizations = organizations.Where(o => o.Status == s);
        }

        if (accountManagerId is { } managerId)
        {
            organizations = organizations.Where(o => o.AccountManagerId == managerId);
        }

        return organizations;
    }

    public static async Task<Guid?> FindDuplicateAsync(this CustomersDbContext db, string? orgNumber, Guid? excludeId, CancellationToken ct)
    {
        if (orgNumber is null)
        {
            return null;
        }

        var id = await db.Organizations.AsNoTracking()
            .Where(o => o.OrgNumber == orgNumber && o.Id != excludeId)
            .Select(o => (Guid?)o.Id)
            .FirstOrDefaultAsync(ct);
        return id;
    }

    public static async Task<OrganizationResponse> ToResponseAsync(
        this Organization o, IUserDirectory users, CustomersDbContext db, CancellationToken ct)
    {
        var ids = new[] { o.AccountManagerId, o.PrimaryTechnicianId }.Where(i => i.HasValue).Select(i => i!.Value).Distinct().ToList();
        var lookup = await users.GetUsersAsync(ids, ct);
        UserRefDto? Ref(Guid? id) => id is { } v && lookup.TryGetValue(v, out var u) ? new UserRefDto(u.Id, u.DisplayName) : null;

        var parent = o.ParentId is { } parentId
            ? await db.Organizations.AsNoTracking()
                .Where(p => p.Id == parentId)
                .Select(p => new OrganizationGroupMember(p.Id, p.Name, p.Status, o.BilledThroughParent))
                .SingleOrDefaultAsync(ct)
            : null;
        var children = await db.Organizations.AsNoTracking()
            .Where(c => c.ParentId == o.Id)
            .OrderBy(c => c.Name)
            .Select(c => new OrganizationGroupMember(c.Id, c.Name, c.Status, c.BilledThroughParent))
            .ToListAsync(ct);

        return new OrganizationResponse(
            o.Id, o.Name, o.OrgNumber, o.LegalForm, o.Status, o.NaceCode, o.Website, o.Phone, o.Email, o.InvoiceEmail, o.EhfEnabled,
            Ref(o.AccountManagerId), Ref(o.PrimaryTechnicianId),
            AddressDto.From(o.PostalAddress), AddressDto.From(o.VisitAddress), AddressDto.From(o.BillingAddress),
            o.Domains, o.RegistryStatus, o.RegistryCheckedAt, parent, o.BilledThroughParent, children, o.CreatedAt, o.ModifiedAt);
    }
}
