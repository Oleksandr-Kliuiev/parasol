using System.Security.Cryptography;
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
public sealed class Contact : AuditableEntity, IErasable
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

    /// <inheritdoc />
    public string? ErasureReference { get; private set; }

    /// <summary>The name an erased person is shown under (SEC-GDPR-04): derived from the record's id, not from the person.</summary>
    public static string PseudonymFor(Guid id) => $"Anonymized-{Convert.ToHexStringLower(SHA256.HashData(id.ToByteArray()))[..8]}";

    public bool IsPseudonymized =>
        FirstName == PseudonymFor(Id) && LastName.Length == 0 && Email is null && Phone is null && MobilePhone is null && PreferredLanguage is null;

    /// <summary>
    /// Erases the person under a privacy case or a retention policy (DEV-11): the row stays — quotes, deals, activities and
    /// tickets refer to it — with a pseudonym instead of a name, no contact details, out of every list; each affiliation is
    /// ended the same way, except those a legal hold keeps (<paramref name="keepAffiliations"/>). Raises nothing: an erasure
    /// is not a change to send to PowerOffice or anywhere else. Returns false when there was nothing left to erase.
    /// </summary>
    public bool Pseudonymize(string reference, IReadOnlySet<Guid>? keepAffiliations = null)
    {
        var changed = false;
        if (!IsPseudonymized || !IsDeleted)
        {
            ErasureReference = reference;
            FirstName = PseudonymFor(Id);
            LastName = string.Empty;
            Email = null;
            Phone = null;
            MobilePhone = null;
            PreferredLanguage = null;
            MarkDeleted();
            changed = true;
        }

        foreach (var affiliation in _affiliations.Where(a => keepAffiliations?.Contains(a.Id) != true))
        {
            changed |= affiliation.Erase(reference);
        }

        return changed;
    }
    public static Result<Contact> Create(ContactDetails details)
    {
        var contact = new Contact();
        var applied = contact.Apply(details);
        if (!applied.IsSuccess)
        {
            return applied.Error!;
        }

        contact.Raise(new ContactCreated(contact.Id));
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

public sealed class OrganizationContact : AuditableEntity, IErasable
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

    /// <inheritdoc />
    public string? ErasureReference { get; private set; }

    /// <summary>Ends an erased person's affiliation: no title, inactive, out of the organization's list (DEV-11).</summary>
    internal bool Erase(string reference)
    {
        if (Title is null && !IsActive && !IsPrimary && IsDeleted)
        {
            return false;
        }

        ErasureReference = reference;
        Title = null;
        IsActive = false;
        IsPrimary = false;
        MarkDeleted();
        return true;
    }

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
