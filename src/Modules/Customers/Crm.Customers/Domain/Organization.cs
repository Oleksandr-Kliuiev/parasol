using System.Globalization;
using Crm.Customers.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Customers.Domain;

public sealed record Address(string? Street, string? PostalCode, string? City, string? CountryCode)
{
    public static readonly Address Empty = new(null, null, null, null);

    /// <summary>Trims values; an address with only a country code (a form default) counts as empty.</summary>
    public Address Normalize()
    {
        var normalized = new Address(Clean(Street), Clean(PostalCode), Clean(City), Clean(CountryCode)?.ToUpperInvariant());
        return normalized is { Street: null, PostalCode: null, City: null } ? Empty : normalized;
    }

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

public sealed record OrganizationDetails(
    string Name,
    string? OrgNumber,
    string? LegalForm,
    OrganizationStatus Status,
    string? NaceCode,
    string? Website,
    string? Phone,
    string? Email,
    string? InvoiceEmail,
    bool EhfEnabled,
    Guid? AccountManagerId,
    Guid? PrimaryTechnicianId,
    Address? PostalAddress,
    Address? VisitAddress,
    Address? BillingAddress,
    IReadOnlyCollection<string>? Domains);

public sealed record OrganizationSnapshot(OrganizationDetails Details, BrregStatus RegistryStatus, DateTimeOffset? RegistryCheckedAt);

public sealed class Organization : AuditableEntity
{
    private Organization() { }

    public string Name { get; private set; } = string.Empty;
    public string? OrgNumber { get; private set; }
    public string? LegalForm { get; private set; }
    public OrganizationStatus Status { get; private set; }
    public string? NaceCode { get; private set; }
    public string? Website { get; private set; }
    public string? Phone { get; private set; }
    public string? Email { get; private set; }
    public string? InvoiceEmail { get; private set; }
    public bool EhfEnabled { get; private set; }
    public Guid? AccountManagerId { get; private set; }
    public Guid? PrimaryTechnicianId { get; private set; }
    public Address PostalAddress { get; private set; } = Address.Empty;
    public Address VisitAddress { get; private set; } = Address.Empty;
    public Address BillingAddress { get; private set; } = Address.Empty;
    public string[] Domains { get; private set; } = [];
    public BrregStatus RegistryStatus { get; private set; }
    public DateTimeOffset? RegistryCheckedAt { get; private set; }

    /// <summary>Set on a soft-deleted organization that was merged into another one.</summary>
    public Guid? MergedIntoId { get; private set; }

    /// <summary>The group company this organization belongs to (FR-CUS-07).</summary>
    public Guid? ParentId { get; private set; }

    /// <summary>The parent is invoiced for this organization: its lines join the parent's billing basis (BR-BIL-12).</summary>
    public bool BilledThroughParent { get; private set; }

    /// <summary>Places the organization under a parent, or removes it from the group when <paramref name="parentId"/> is null.</summary>
    public Result SetParent(Guid? parentId, bool billedThroughParent)
    {
        if (parentId == Id)
        {
            return Error.Validation("CUS_PARENT_SELF", "An organization cannot be its own parent.");
        }

        ParentId = parentId;
        BilledThroughParent = parentId is not null && billedThroughParent;
        Raise(new OrganizationUpdated(Id));
        return Result.Success();
    }

    public static Result<Organization> Create(OrganizationDetails details)
    {
        var organization = new Organization();
        var applied = organization.Apply(details);
        if (!applied.IsSuccess)
        {
            return applied.Error!;
        }

        organization.Raise(new OrganizationCreated(organization.Id, organization.Name, organization.OrgNumber));
        return organization;
    }

    public Result Update(OrganizationDetails details)
    {
        var applied = Apply(details);
        if (applied.IsSuccess)
        {
            Raise(new OrganizationUpdated(Id));
        }

        return applied;
    }

    /// <summary>Sets invoice e-mail, EHF and billing address from the billing master system; returns true when anything changed.</summary>
    public bool ApplyBillingDetails(string? invoiceEmail, bool? ehfEnabled, Address? billingAddress)
    {
        var before = (InvoiceEmail, EhfEnabled, BillingAddress);
        InvoiceEmail = string.IsNullOrWhiteSpace(invoiceEmail) ? null : invoiceEmail.Trim().ToLowerInvariant();
        EhfEnabled = ehfEnabled ?? EhfEnabled;
        BillingAddress = (billingAddress ?? Address.Empty).Normalize();
        if (before == (InvoiceEmail, EhfEnabled, BillingAddress))
        {
            return false;
        }

        Raise(new OrganizationUpdated(Id));
        return true;
    }

    /// <summary>Keeps the billing fields owned by another system when the rest of the organization is edited in the CRM.</summary>
    internal OrganizationDetails WithBillingDetailsOf(OrganizationDetails details) =>
        details with { InvoiceEmail = InvoiceEmail, EhfEnabled = EhfEnabled, BillingAddress = BillingAddress };

    public void ApplyRegistryStatus(BrregStatus status, DateTimeOffset checkedAt)
    {
        var previous = RegistryStatus;
        RegistryStatus = status;
        RegistryCheckedAt = checkedAt;
        if (previous != status && previous != BrregStatus.Unknown)
        {
            Raise(new OrganizationRegistryStatusChanged(Id, previous, status));
        }
    }

    public override void MarkDeleted()
    {
        base.MarkDeleted();
        Raise(new OrganizationDeleted(Id));
    }

    /// <summary>Snapshot of every editable field, used to undo a merge.</summary>
    public OrganizationSnapshot Snapshot() => new(
        new OrganizationDetails(Name, OrgNumber, LegalForm, Status, NaceCode, Website, Phone, Email, InvoiceEmail, EhfEnabled,
            AccountManagerId, PrimaryTechnicianId, PostalAddress, VisitAddress, BillingAddress, Domains),
        RegistryStatus,
        RegistryCheckedAt);

    internal void Restore(OrganizationSnapshot snapshot)
    {
        Apply(snapshot.Details);
        RegistryStatus = snapshot.RegistryStatus;
        RegistryCheckedAt = snapshot.RegistryCheckedAt;
    }

    /// <summary>
    /// Takes over what the source knows and the target does not (BR-CUS-06): empty fields are filled, domains are united,
    /// EHF is kept if either had it, and the more advanced relationship status wins. Values already on the target are kept.
    /// </summary>
    internal void AbsorbFrom(OrganizationSnapshot source)
    {
        var d = source.Details;
        LegalForm ??= d.LegalForm;
        NaceCode ??= d.NaceCode;
        Website ??= d.Website;
        Phone ??= d.Phone;
        Email ??= d.Email;
        InvoiceEmail ??= d.InvoiceEmail;
        AccountManagerId ??= d.AccountManagerId;
        PrimaryTechnicianId ??= d.PrimaryTechnicianId;
        EhfEnabled = EhfEnabled || d.EhfEnabled;
        PostalAddress = PostalAddress == Address.Empty ? (d.PostalAddress ?? Address.Empty) : PostalAddress;
        VisitAddress = VisitAddress == Address.Empty ? (d.VisitAddress ?? Address.Empty) : VisitAddress;
        BillingAddress = BillingAddress == Address.Empty ? (d.BillingAddress ?? Address.Empty) : BillingAddress;
        Domains = Domains.Union(d.Domains ?? [], StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        if (StatusRank(d.Status) > StatusRank(Status))
        {
            Status = d.Status;
        }

        if (OrgNumber is null && d.OrgNumber is not null)
        {
            OrgNumber = d.OrgNumber;
            RegistryStatus = source.RegistryStatus;
            RegistryCheckedAt = source.RegistryCheckedAt;
        }

        Raise(new OrganizationUpdated(Id));
    }

    /// <summary>Soft-deletes the source of a merge. The org number is released so the target can take it over.</summary>
    internal void MarkMergedInto(Guid mergeId, Guid targetId)
    {
        base.MarkDeleted();
        MergedIntoId = targetId;
        OrgNumber = null;
        Raise(new OrganizationsMerged(mergeId, targetId, Id));
    }

    internal void UndoMerge(Guid mergeId, OrganizationSnapshot snapshot)
    {
        var targetId = MergedIntoId ?? Guid.Empty;
        base.Restore();
        MergedIntoId = null;
        Restore(snapshot);
        Raise(new OrganizationMergeUndone(mergeId, targetId, Id));
    }

    private static int StatusRank(OrganizationStatus status) => status switch
    {
        OrganizationStatus.Customer => 4,
        OrganizationStatus.Partner => 3,
        OrganizationStatus.Prospect => 2,
        OrganizationStatus.Lead => 1,
        _ => 0,
    };

    private Result Apply(OrganizationDetails details)
    {
        if (string.IsNullOrWhiteSpace(details.Name))
        {
            return Error.Validation("CUS_NAME_REQUIRED", "Organization name is required.");
        }

        var orgNumber = Domain.OrgNumber.Parse(details.OrgNumber);
        if (!orgNumber.IsSuccess)
        {
            return orgNumber.Error!;
        }

        if (orgNumber.Value != OrgNumber)
        {
            // A different registry entity: its registry status must be checked again.
            RegistryStatus = BrregStatus.Unknown;
            RegistryCheckedAt = null;
        }

        Name = details.Name.Trim();
        OrgNumber = orgNumber.Value;
        LegalForm = Clean(details.LegalForm)?.ToUpperInvariant();
        Status = details.Status;
        NaceCode = Clean(details.NaceCode);
        Website = NormalizeWebsite(details.Website);
        Phone = Clean(details.Phone);
        Email = Clean(details.Email)?.ToLowerInvariant();
        InvoiceEmail = Clean(details.InvoiceEmail)?.ToLowerInvariant();
        EhfEnabled = details.EhfEnabled;
        AccountManagerId = details.AccountManagerId;
        PrimaryTechnicianId = details.PrimaryTechnicianId;
        PostalAddress = (details.PostalAddress ?? Address.Empty).Normalize();
        VisitAddress = (details.VisitAddress ?? Address.Empty).Normalize();
        BillingAddress = (details.BillingAddress ?? Address.Empty).Normalize();
        Domains = NormalizeDomains(details.Domains);
        return Result.Success();
    }

    private static string[] NormalizeDomains(IReadOnlyCollection<string>? domains) =>
        (domains ?? [])
            .Select(d => d.Trim().TrimStart('@').ToLower(CultureInfo.InvariantCulture))
            .Where(d => d.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>"havbris.no" → "https://havbris.no", so the website is always an absolute link.</summary>
    private static string? NormalizeWebsite(string? value) =>
        Clean(value) is { } site && !site.Contains("://", StringComparison.Ordinal) ? "https://" + site : Clean(value);
}
