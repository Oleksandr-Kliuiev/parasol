using Crm.Customers.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Customers.Domain;

[Flags]
public enum ContactRoles
{
    None = 0,
    DecisionMaker = 1,
    Technical = 2,
    Billing = 4,
    EndUser = 8,
}

public sealed record ContactDetails(
    string FirstName,
    string LastName,
    string? Email,
    string? Phone,
    string? MobilePhone,
    string? PreferredLanguage);

public sealed record AffiliationDetails(string? Title, ContactRoles Roles, bool IsPrimary, bool IsActive = true);

/// <summary>A person. One person can work with several organizations, each through its own affiliation (BR-CUS-05).</summary>
public sealed class Contact : AuditableEntity
{
    private readonly List<OrganizationContact> _affiliations = [];

    private Contact() { }

    public string FirstName { get; private set; } = string.Empty;
    public string LastName { get; private set; } = string.Empty;
    public string? Email { get; private set; }
    public string? Phone { get; private set; }
    public string? MobilePhone { get; private set; }
    public string? PreferredLanguage { get; private set; }

    public IReadOnlyCollection<OrganizationContact> Affiliations => _affiliations;

    public string FullName => $"{FirstName} {LastName}".Trim();

    public static Result<Contact> Create(ContactDetails details)
    {
        var contact = new Contact();
        var applied = contact.Apply(details);
        if (!applied.IsSuccess)
        {
            return applied.Error!;
        }

        contact.Raise(new ContactCreated(contact.Id, contact.Email));
        return contact;
    }

    public Result Update(ContactDetails details)
    {
        var before = (FirstName, LastName, Email, Phone, MobilePhone);
        var applied = Apply(details);
        if (applied.IsSuccess && before != (FirstName, LastName, Email, Phone, MobilePhone))
        {
            Raise(new ContactUpdated(Id));
        }

        return applied;
    }

    public Result Affiliate(Guid organizationId, AffiliationDetails details)
    {
        var existing = _affiliations.FirstOrDefault(a => a.OrganizationId == organizationId);
        if (existing is { IsActive: true })
        {
            return Error.Conflict("CUS_DUPLICATE_CONTACT", "This person is already a contact of the organization.",
                new Dictionary<string, object?> { ["contactId"] = Id });
        }

        if (existing is not null)
        {
            existing.Update(details with { IsActive = true });
        }
        else
        {
            _affiliations.Add(new OrganizationContact(organizationId, Id, details));
        }

        Raise(new ContactAffiliationChanged(Id, organizationId));
        return Result.Success();
    }

    public Result UpdateAffiliation(Guid organizationId, AffiliationDetails details)
    {
        var affiliation = _affiliations.FirstOrDefault(a => a.OrganizationId == organizationId);
        if (affiliation is null)
        {
            return Error.NotFound("CUS_AFFILIATION_NOT_FOUND", "The person is not a contact of this organization.");
        }

        affiliation.Update(details);
        Raise(new ContactAffiliationChanged(Id, organizationId));
        return Result.Success();
    }

    private Result Apply(ContactDetails details)
    {
        if (string.IsNullOrWhiteSpace(details.FirstName) && string.IsNullOrWhiteSpace(details.LastName))
        {
            return Error.Validation("CUS_CONTACT_NAME_REQUIRED", "First name or last name is required.");
        }

        FirstName = details.FirstName?.Trim() ?? string.Empty;
        LastName = details.LastName?.Trim() ?? string.Empty;
        Email = NormalizeEmail(details.Email);
        Phone = Clean(details.Phone);
        MobilePhone = Clean(details.MobilePhone);
        PreferredLanguage = Clean(details.PreferredLanguage);
        return Result.Success();
    }

    public static string? NormalizeEmail(string? email) =>
        string.IsNullOrWhiteSpace(email) ? null : email.Trim().ToLowerInvariant();

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

public sealed class OrganizationContact : AuditableEntity
{
    private OrganizationContact() { }

    internal OrganizationContact(Guid organizationId, Guid contactId, AffiliationDetails details)
    {
        OrganizationId = organizationId;
        ContactId = contactId;
        Update(details);
    }

    public Guid OrganizationId { get; private set; }
    public Guid ContactId { get; private set; }
    public string? Title { get; private set; }
    public ContactRoles Roles { get; private set; }
    public bool IsPrimary { get; private set; }
    public bool IsActive { get; private set; }

    internal void Update(AffiliationDetails details)
    {
        Title = string.IsNullOrWhiteSpace(details.Title) ? null : details.Title.Trim();
        Roles = details.Roles;
        IsActive = details.IsActive;
        IsPrimary = details.IsActive && details.IsPrimary;
    }

    internal void ClearPrimary() => IsPrimary = false;

    /// <summary>Moves the affiliation to another organization (organization merge and its undo).</summary>
    internal void MoveTo(Guid organizationId) => OrganizationId = organizationId;
}
