using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Contacts;

public sealed record ContactPersonRequest(
    string FirstName,
    string LastName,
    string? Email,
    string? Phone,
    string? MobilePhone,
    string? PreferredLanguage)
{
    internal ContactDetails ToDetails() => new(FirstName, LastName, Email, Phone, MobilePhone, PreferredLanguage);
}

public sealed record AffiliationRequest(string? Title, IReadOnlyList<string>? Roles, bool IsPrimary, bool IsActive = true)
{
    internal AffiliationDetails ToDetails() => new(Title, ContactRoleNames.Parse(Roles), IsPrimary, IsActive);
}

public sealed record CreateOrganizationContactRequest(
    string FirstName,
    string LastName,
    string? Email,
    string? Phone,
    string? MobilePhone,
    string? PreferredLanguage,
    string? Title,
    IReadOnlyList<string>? Roles,
    bool IsPrimary);

public sealed record OrganizationContactItem(
    Guid ContactId,
    string FirstName,
    string LastName,
    string? Email,
    string? Phone,
    string? MobilePhone,
    string? Title,
    IReadOnlyList<string> Roles,
    bool IsPrimary,
    bool IsActive);

public sealed record ContactAffiliationDto(Guid OrganizationId, string OrganizationName, string? Title, IReadOnlyList<string> Roles, bool IsPrimary, bool IsActive);

public sealed record ContactResponse(
    Guid Id,
    string FirstName,
    string LastName,
    string? Email,
    string? Phone,
    string? MobilePhone,
    string? PreferredLanguage,
    IReadOnlyList<ContactAffiliationDto> Affiliations,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ModifiedAt);

public sealed record CreatedContact(Guid ContactId, bool LinkedExisting);

public static class ContactRoleNames
{
    public static IReadOnlyList<string> All { get; } =
        Enum.GetValues<ContactRoles>().Where(r => r != ContactRoles.None).Select(r => r.ToString()).ToList();

    public static ContactRoles Parse(IReadOnlyList<string>? names) =>
        (names ?? []).Aggregate(ContactRoles.None, (acc, name) =>
            Enum.TryParse<ContactRoles>(name, ignoreCase: true, out var role) ? acc | role : acc);

    public static IReadOnlyList<string> ToNames(ContactRoles roles) =>
        Enum.GetValues<ContactRoles>().Where(r => r != ContactRoles.None && roles.HasFlag(r)).Select(r => r.ToString()).ToList();

    public static bool AreValid(IReadOnlyList<string>? names) =>
        names is null || names.All(n => All.Contains(n, StringComparer.OrdinalIgnoreCase));
}

internal sealed class CreateOrganizationContactRequestValidator : AbstractValidator<CreateOrganizationContactRequest>
{
    public CreateOrganizationContactRequestValidator()
    {
        RuleFor(x => x).Must(x => !string.IsNullOrWhiteSpace(x.FirstName) || !string.IsNullOrWhiteSpace(x.LastName))
            .WithName("name").WithMessage("First name or last name is required.");
        RuleFor(x => x.FirstName).MaximumLength(128);
        RuleFor(x => x.LastName).MaximumLength(128);
        RuleFor(x => x.Email).EmailAddress().MaximumLength(256).When(x => !string.IsNullOrWhiteSpace(x.Email));
        RuleFor(x => x.Phone).MaximumLength(32);
        RuleFor(x => x.MobilePhone).MaximumLength(32);
        RuleFor(x => x.Title).MaximumLength(128);
        RuleFor(x => x.Roles).Must(ContactRoleNames.AreValid).WithMessage($"Roles must be among: {string.Join(", ", ContactRoleNames.All)}.");
    }
}

internal sealed class ContactPersonRequestValidator : AbstractValidator<ContactPersonRequest>
{
    public ContactPersonRequestValidator()
    {
        RuleFor(x => x).Must(x => !string.IsNullOrWhiteSpace(x.FirstName) || !string.IsNullOrWhiteSpace(x.LastName))
            .WithName("name").WithMessage("First name or last name is required.");
        RuleFor(x => x.FirstName).MaximumLength(128);
        RuleFor(x => x.LastName).MaximumLength(128);
        RuleFor(x => x.Email).EmailAddress().MaximumLength(256).When(x => !string.IsNullOrWhiteSpace(x.Email));
    }
}

internal sealed class AffiliationRequestValidator : AbstractValidator<AffiliationRequest>
{
    public AffiliationRequestValidator()
    {
        RuleFor(x => x.Title).MaximumLength(128);
        RuleFor(x => x.Roles).Must(ContactRoleNames.AreValid).WithMessage($"Roles must be among: {string.Join(", ", ContactRoleNames.All)}.");
    }
}

public sealed record ListOrganizationContacts(Guid OrganizationId, bool IncludeInactive);

public sealed record CreateOrganizationContact(Guid OrganizationId, CreateOrganizationContactRequest Request);

public sealed record GetContact(Guid ContactId);

public sealed record UpdateContactPerson(Guid ContactId, ContactPersonRequest Request, string IfMatch);

public sealed record UpdateAffiliation(Guid OrganizationId, Guid ContactId, AffiliationRequest Request);

internal static class ContactErrors
{
    public static Error NotFound(Guid id) => Error.NotFound("CUS_CONTACT_NOT_FOUND", $"Contact {id} was not found.");

    public static Error OrganizationNotFound(Guid id) => Error.NotFound("CUS_ORGANIZATION_NOT_FOUND", $"Organization {id} was not found.");

    public static Error DuplicateEmail(Guid existingId) => Error.Conflict(
        "CUS_DUPLICATE_CONTACT_EMAIL", "Another contact already uses this e-mail address.",
        new Dictionary<string, object?> { ["existingId"] = existingId });
}

internal sealed class ListOrganizationContactsHandler(CustomersDbContext db)
    : IQueryHandler<ListOrganizationContacts, Result<IReadOnlyList<OrganizationContactItem>>>
{
    public async Task<Result<IReadOnlyList<OrganizationContactItem>>> HandleAsync(ListOrganizationContacts query, CancellationToken cancellationToken)
    {
        if (!await db.Organizations.AnyAsync(o => o.Id == query.OrganizationId, cancellationToken))
        {
            return ContactErrors.OrganizationNotFound(query.OrganizationId);
        }

        var rows = await (
                from a in db.OrganizationContacts.AsNoTracking()
                join c in db.Contacts.AsNoTracking() on a.ContactId equals c.Id
                where a.OrganizationId == query.OrganizationId && (query.IncludeInactive || a.IsActive)
                orderby a.IsPrimary descending, c.LastName, c.FirstName
                select new { c.Id, c.FirstName, c.LastName, c.Email, c.Phone, c.MobilePhone, a.Title, a.Roles, a.IsPrimary, a.IsActive })
            .ToListAsync(cancellationToken);

        return rows.Select(r => new OrganizationContactItem(
                r.Id, r.FirstName, r.LastName, r.Email, r.Phone, r.MobilePhone, r.Title, ContactRoleNames.ToNames(r.Roles), r.IsPrimary, r.IsActive))
            .ToList();
    }
}

internal sealed class CreateOrganizationContactHandler(CustomersDbContext db)
    : ICommandHandler<CreateOrganizationContact, Result<CreatedContact>>
{
    public async Task<Result<CreatedContact>> HandleAsync(CreateOrganizationContact command, CancellationToken cancellationToken)
    {
        var request = command.Request;
        if (!await db.Organizations.AnyAsync(o => o.Id == command.OrganizationId, cancellationToken))
        {
            return ContactErrors.OrganizationNotFound(command.OrganizationId);
        }

        var email = Contact.NormalizeEmail(request.Email);
        var contact = email is null
            ? null
            : await db.Contacts.Include(c => c.Affiliations).SingleOrDefaultAsync(c => c.Email == email, cancellationToken);
        var linkedExisting = contact is not null;

        if (contact is null)
        {
            var created = Contact.Create(new ContactDetails(
                request.FirstName, request.LastName, request.Email, request.Phone, request.MobilePhone, request.PreferredLanguage));
            if (!created.IsSuccess)
            {
                return created.Error!;
            }

            contact = created.Value;
            db.Contacts.Add(contact);
        }

        var affiliation = new AffiliationDetails(request.Title, ContactRoleNames.Parse(request.Roles), request.IsPrimary);
        var affiliated = contact.Affiliate(command.OrganizationId, affiliation);
        if (!affiliated.IsSuccess)
        {
            return affiliated.Error!;
        }

        if (affiliation.IsPrimary)
        {
            await db.ClearOtherPrimaryAsync(command.OrganizationId, contact.Id, cancellationToken);
        }

        await db.SaveChangesAsync(cancellationToken);
        return new CreatedContact(contact.Id, linkedExisting);
    }
}

internal sealed class GetContactHandler(CustomersDbContext db) : IQueryHandler<GetContact, Result<(ContactResponse Contact, string Etag)>>
{
    public async Task<Result<(ContactResponse Contact, string Etag)>> HandleAsync(GetContact query, CancellationToken cancellationToken)
    {
        // Tracked on purpose: the ETag is read from the RowVersion shadow property.
        var contact = await db.Contacts.Include(c => c.Affiliations)
            .SingleOrDefaultAsync(c => c.Id == query.ContactId, cancellationToken);
        if (contact is null)
        {
            return ContactErrors.NotFound(query.ContactId);
        }

        return (await contact.ToResponseAsync(db, cancellationToken), db.GetETag(contact));
    }
}

internal sealed class UpdateContactPersonHandler(CustomersDbContext db)
    : ICommandHandler<UpdateContactPerson, Result<(ContactResponse Contact, string Etag)>>
{
    public async Task<Result<(ContactResponse Contact, string Etag)>> HandleAsync(UpdateContactPerson command, CancellationToken cancellationToken)
    {
        var contact = await db.Contacts.Include(c => c.Affiliations).SingleOrDefaultAsync(c => c.Id == command.ContactId, cancellationToken);
        if (contact is null)
        {
            return ContactErrors.NotFound(command.ContactId);
        }

        if (!db.ApplyIfMatch(contact, command.IfMatch))
        {
            return Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
        }

        var email = Contact.NormalizeEmail(command.Request.Email);
        if (email is not null && await db.Contacts.AnyAsync(c => c.Email == email && c.Id != contact.Id, cancellationToken))
        {
            var existingId = await db.Contacts.Where(c => c.Email == email).Select(c => c.Id).FirstAsync(cancellationToken);
            return ContactErrors.DuplicateEmail(existingId);
        }

        var updated = contact.Update(command.Request.ToDetails());
        if (!updated.IsSuccess)
        {
            return updated.Error!;
        }

        await db.SaveChangesAsync(cancellationToken);
        return (await contact.ToResponseAsync(db, cancellationToken), db.GetETag(contact));
    }
}

internal sealed class UpdateAffiliationHandler(CustomersDbContext db) : ICommandHandler<UpdateAffiliation, Result>
{
    public async Task<Result> HandleAsync(UpdateAffiliation command, CancellationToken cancellationToken)
    {
        var contact = await db.Contacts.Include(c => c.Affiliations).SingleOrDefaultAsync(c => c.Id == command.ContactId, cancellationToken);
        if (contact is null)
        {
            return ContactErrors.NotFound(command.ContactId);
        }

        var details = command.Request.ToDetails();
        var result = contact.UpdateAffiliation(command.OrganizationId, details);
        if (!result.IsSuccess)
        {
            return result;
        }

        if (details is { IsPrimary: true, IsActive: true })
        {
            await db.ClearOtherPrimaryAsync(command.OrganizationId, contact.Id, cancellationToken);
        }

        await db.SaveChangesAsync(cancellationToken);
        return Result.Success();
    }
}

internal static class ContactQueries
{
    public static async Task ClearOtherPrimaryAsync(this CustomersDbContext db, Guid organizationId, Guid keepContactId, CancellationToken ct)
    {
        var others = await db.OrganizationContacts
            .Where(a => a.OrganizationId == organizationId && a.IsPrimary && a.ContactId != keepContactId)
            .ToListAsync(ct);
        others.ForEach(a => a.ClearPrimary());
    }

    public static async Task<ContactResponse> ToResponseAsync(this Contact contact, CustomersDbContext db, CancellationToken ct)
    {
        var organizationIds = contact.Affiliations.Select(a => a.OrganizationId).ToList();
        var names = await db.Organizations.AsNoTracking().IgnoreQueryFilters()
            .Where(o => organizationIds.Contains(o.Id))
            .ToDictionaryAsync(o => o.Id, o => o.Name, ct);

        return new ContactResponse(
            contact.Id, contact.FirstName, contact.LastName, contact.Email, contact.Phone, contact.MobilePhone, contact.PreferredLanguage,
            contact.Affiliations
                .OrderByDescending(a => a.IsActive).ThenBy(a => names.GetValueOrDefault(a.OrganizationId))
                .Select(a => new ContactAffiliationDto(
                    a.OrganizationId, names.GetValueOrDefault(a.OrganizationId, "?"), a.Title, ContactRoleNames.ToNames(a.Roles), a.IsPrimary, a.IsActive))
                .ToList(),
            contact.CreatedAt, contact.ModifiedAt);
    }
}
