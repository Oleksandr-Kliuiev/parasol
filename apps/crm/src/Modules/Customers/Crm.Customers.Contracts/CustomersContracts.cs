using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Customers.Contracts;

public enum OrganizationStatus
{
    Lead,
    Prospect,
    Customer,
    Former,
    Partner,
}

/// <summary>Status of the organization in Enhetsregisteret (docs/02-functional-spec.md BR-CUS-03).</summary>
public enum BrregStatus
{
    Unknown,
    Active,
    UnderDissolution,
    Bankrupt,
    Deleted,
    NotFound,
}

public sealed record OrganizationRef(Guid Id, string Name, string? OrgNumber, OrganizationStatus Status, Guid? AccountManagerId);

/// <summary>Which system owns invoice e-mail, EHF and billing address (docs/04-data-model.md §3). Configurable: Customers:BillingDetailsMaster.</summary>
public enum BillingDetailsMaster
{
    Crm,
    PowerOffice,
}

public sealed record AddressData(string? Street, string? PostalCode, string? City, string? CountryCode);

public sealed record BillingData(string? InvoiceEmail, bool? EhfEnabled, AddressData? Address);

/// <summary>Organization data coming from an external system (import or matching).</summary>
public sealed record ExternalOrganizationData(
    string Name,
    string? OrgNumber,
    string? Email,
    string? Phone,
    string? Website,
    IReadOnlyCollection<string> Domains,
    AddressData? VisitAddress,
    AddressData? PostalAddress,
    BillingData? Billing)
{
    /// <summary>Stable local external-record key for crash-safe creation; never a user-supplied customer number.</summary>
    public Guid? SourceRecordId { get; init; }

    /// <summary>Calculate the same import decision without saving entities, affiliations or events.</summary>
    public bool PreviewOnly { get; init; }
}

public enum MatchReason
{
    OrgNumber,
    SameName,
    SharedDomain,
    SameEmailDomain,
    SamePhone,
}

public sealed record OrganizationMatch(Guid OrganizationId, string Name, string? OrgNumber, IReadOnlyList<MatchReason> Reasons)
{
    /// <summary>An org number match is unambiguous and may be linked automatically.</summary>
    public bool IsExact => Reasons.Contains(MatchReason.OrgNumber);
}

/// <summary>Matches many external records against a snapshot of all organizations loaded once.</summary>
public interface IOrganizationMatcher
{
    IReadOnlyList<OrganizationMatch> Match(ExternalOrganizationData data, int take = 3);
}

public sealed record ImportOrganizationResult(Guid OrganizationId, bool Created);

/// <summary>Everything an integration needs to push an organization to an external system.</summary>
public sealed record OrganizationSyncView(
    Guid Id,
    string Name,
    string? OrgNumber,
    OrganizationStatus Status,
    string? Email,
    string? Phone,
    string? Website,
    IReadOnlyList<string> Domains,
    AddressData VisitAddress,
    AddressData PostalAddress,
    BillingData Billing,
    bool IsDeleted);

public sealed record ExternalContactData(string FirstName, string LastName, string? Email, string? Phone, string? MobilePhone, string? Title)
{
    /// <summary>Stable local external-record key; allows resuming contacts that have no e-mail address.</summary>
    public Guid? SourceRecordId { get; init; }

    /// <summary>Calculate the same import decision without saving entities, affiliations or events.</summary>
    public bool PreviewOnly { get; init; }
}

public sealed record ImportContactResult(Guid ContactId, bool Created);

public sealed record ContactAffiliationView(Guid OrganizationId, string? Title, bool IsBilling, bool IsPrimary, bool IsActive);

/// <summary>Everything an integration needs to push a contact person to an external system.</summary>
public sealed record ContactSyncView(
    Guid Id,
    string FirstName,
    string LastName,
    string? Email,
    string? Phone,
    string? MobilePhone,
    bool IsDeleted,
    IReadOnlyList<ContactAffiliationView> Affiliations)
{
    /// <summary>Sync views contain only nondeleted affiliations; exporting also requires an active exact customer affiliation.</summary>
    public bool IsUsableFor(Guid organizationId) => !IsDeleted && Affiliations.Any(a => a.OrganizationId == organizationId && a.IsActive);
}

/// <summary>Public API of the Customers module for other modules and integrations.</summary>
public interface ICustomersApi
{
    /// <summary>Holds a read-only row lease while a different module commits its own operation; merge/delete waits for release.</summary>
    Task<Result<T>> WithUsableOrganizationAsync<T>(Guid organizationId,
        Func<OrganizationRef, CancellationToken, Task<Result<T>>> action, CancellationToken cancellationToken);
    Task<OrganizationRef?> GetOrganizationAsync(Guid organizationId, CancellationToken cancellationToken);

    /// <summary>Organizations with an org number whose registry status was last checked before <paramref name="checkedBefore"/>.</summary>
    Task<IReadOnlyList<OrganizationRef>> GetOrganizationsDueForRegistryCheckAsync(
        DateTimeOffset checkedBefore, int take, CancellationToken cancellationToken);

    Task ApplyRegistryStatusAsync(Guid organizationId, BrregStatus status, DateTimeOffset checkedAt, CancellationToken cancellationToken);

    BillingDetailsMaster BillingDetailsMaster { get; }

    Task<IOrganizationMatcher> CreateMatcherAsync(CancellationToken cancellationToken);

    /// <summary>Creates an organization from external data, or returns the existing one with the same org number.</summary>
    Task<ImportOrganizationResult> ImportOrganizationAsync(ExternalOrganizationData data, OrganizationStatus status, CancellationToken cancellationToken);

    /// <summary>Applies billing details from the external master. Ignored unless <see cref="BillingDetailsMaster"/> is PowerOffice.</summary>
    Task<bool> ApplyExternalBillingDetailsAsync(Guid organizationId, BillingData billing, CancellationToken cancellationToken);

    Task<OrganizationSyncView?> GetOrganizationForSyncAsync(Guid organizationId, CancellationToken cancellationToken);

    Task<IReadOnlyDictionary<Guid, string>> GetOrganizationNamesAsync(IReadOnlyCollection<Guid> organizationIds, CancellationToken cancellationToken);

    /// <summary>
    /// The organizations that hold one of the given organization numbers (white space is ignored), keyed by the number; a number no
    /// organization holds is absent. Reads only what is asked for, so a pilot comparison never loads the whole customer list.
    /// </summary>
    Task<IReadOnlyDictionary<string, Guid>> FindOrganizationsByOrgNumberAsync(IReadOnlyCollection<string> orgNumbers, CancellationToken cancellationToken);

    /// <summary>Organization numbers of the requested organizations; organizations without one are absent.</summary>
    Task<IReadOnlyDictionary<Guid, string>> GetOrgNumbersAsync(IReadOnlyCollection<Guid> organizationIds, CancellationToken cancellationToken);

    /// <summary>Account managers for only the requested organizations; an empty batch performs no lookup.</summary>
    Task<IReadOnlyDictionary<Guid, Guid?>> GetAccountManagerIdsAsync(IReadOnlyCollection<Guid> organizationIds, CancellationToken cancellationToken);

    /// <summary>Every organization as a flat row, for the reporting mart (FR-RPT-03).</summary>
    Task<IReadOnlyList<OrganizationRef>> GetAllOrganizationsAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Organizations whose invoice belongs to a group parent, mapped to the organization that is actually invoiced
    /// (FR-CUS-07). The chain is followed to the top, so a subsidiary of a subsidiary lands on the group's invoice.
    /// </summary>
    Task<IReadOnlyDictionary<Guid, Guid>> GetInvoiceTargetsAsync(CancellationToken cancellationToken);

    /// <summary>Contact ids by normalized e-mail, for automatic linking of external contacts.</summary>
    Task<IReadOnlyDictionary<string, Guid>> FindContactsByEmailAsync(IReadOnlyCollection<string> emails, CancellationToken cancellationToken);

    Task<ContactSyncView?> GetContactForSyncAsync(Guid contactId, CancellationToken cancellationToken);

    Task<IReadOnlyDictionary<Guid, string>> GetContactNamesAsync(IReadOnlyCollection<Guid> contactIds, CancellationToken cancellationToken);

    /// <summary>Active contacts of an organization, primary first; used to look for their correspondence (FR-ACT-03).</summary>
    Task<IReadOnlyList<ContactSyncView>> GetOrganizationContactsAsync(Guid organizationId, CancellationToken cancellationToken);

    /// <summary>Links an existing person by e-mail or creates one, and makes them a contact of the organization.</summary>
    Task<ImportContactResult> ImportContactAsync(Guid organizationId, ExternalContactData data, CancellationToken cancellationToken);

    /// <summary>
    /// Whether a merge was undone. A handler of <see cref="OrganizationsMerged"/> that runs late — retried, or replayed by a
    /// person — asks first, so a merge that is no longer in force is not applied again (DEV-07).
    /// </summary>
    Task<bool> IsMergeUndoneAsync(Guid mergeId, CancellationToken cancellationToken);
}

public sealed record OrganizationCreated(Guid OrganizationId, string Name, string? OrgNumber) : DomainEvent;

public sealed record OrganizationUpdated(Guid OrganizationId) : DomainEvent;

public sealed record OrganizationDeleted(Guid OrganizationId) : DomainEvent;

public sealed record OrganizationRegistryStatusChanged(Guid OrganizationId, BrregStatus Previous, BrregStatus Current) : DomainEvent;

/// <summary>
/// The source organization was merged into the target. Modules holding references to organizations
/// (contracts, subscriptions, external links…) must re-point <see cref="SourceOrganizationId"/> to <see cref="TargetOrganizationId"/>.
/// </summary>
public sealed record OrganizationsMerged(Guid MergeId, Guid TargetOrganizationId, Guid SourceOrganizationId) : DomainEvent;

/// <summary>A merge was undone; references moved by <see cref="OrganizationsMerged"/> handlers should be moved back where possible.</summary>
public sealed record OrganizationMergeUndone(Guid MergeId, Guid TargetOrganizationId, Guid SourceOrganizationId) : DomainEvent;

/// <summary>
/// A person was added. Ids only, like every event about a person: a delivered outbox row is kept for 30 days and would otherwise
/// be a copy of the person's data that an erasure cannot reach (DEV-11).
/// </summary>
public sealed record ContactCreated(Guid ContactId) : DomainEvent;

/// <summary>Name, e-mail or phone of a person changed.</summary>
public sealed record ContactUpdated(Guid ContactId) : DomainEvent;

public sealed record ContactAffiliationChanged(Guid ContactId, Guid OrganizationId) : DomainEvent;

/// <summary>The customer's folder in SharePoint (FR-DOC-01).</summary>
public sealed record DocumentFolder(string FolderId, string Name, string WebUrl);

public sealed record DocumentItem(
    string Id, string Name, bool IsFolder, long? Size, DateTimeOffset? ModifiedAt, string? ModifiedBy, string WebUrl);

/// <summary>
/// The document library that holds a folder per customer (FR-DOC-01). Implemented by the Microsoft Graph integration,
/// which also owns the link between the organization and the folder; the Customers module only asks.
/// </summary>
public interface IDocumentLibrary
{
    /// <summary>False when SharePoint is not configured; the card then explains that instead of failing.</summary>
    bool IsAvailable { get; }

    /// <summary>The folder of an organization, or null when it has not been created yet.</summary>
    Task<DocumentFolder?> GetFolderAsync(Guid organizationId, CancellationToken cancellationToken);

    /// <summary>Creates the folder (named "{organization} ({org number})") if it is missing, and links it.</summary>
    Task<DocumentFolder> EnsureFolderAsync(Guid organizationId, CancellationToken cancellationToken);

    /// <summary>Contents of the customer's folder, folders first; empty when there is no folder yet.</summary>
    Task<IReadOnlyList<DocumentItem>> ListAsync(Guid organizationId, CancellationToken cancellationToken);
}
