using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Customers;

internal sealed class CustomersApi(CustomersDbContext db, IOptions<CustomersOptions> options) : ICustomersApi
{
    public BillingDetailsMaster BillingDetailsMaster => options.Value.BillingDetailsMaster;

    public Task<bool> IsMergeUndoneAsync(Guid mergeId, CancellationToken cancellationToken) =>
        db.OrganizationMerges.AsNoTracking().AnyAsync(m => m.Id == mergeId && m.UndoneAt != null, cancellationToken);

    public Task<OrganizationRef?> GetOrganizationAsync(Guid organizationId, CancellationToken cancellationToken) =>
        db.Organizations.AsNoTracking()
            .Where(o => o.Id == organizationId)
            .Select(o => new OrganizationRef(o.Id, o.Name, o.OrgNumber, o.Status, o.AccountManagerId))
            .SingleOrDefaultAsync(cancellationToken);

    public async Task<IReadOnlyList<OrganizationRef>> GetOrganizationsDueForRegistryCheckAsync(
        DateTimeOffset checkedBefore, int take, CancellationToken cancellationToken) =>
        await db.Organizations.AsNoTracking()
            .Where(o => o.OrgNumber != null && (o.RegistryCheckedAt == null || o.RegistryCheckedAt < checkedBefore))
            .OrderBy(o => o.RegistryCheckedAt)
            .Take(take)
            .Select(o => new OrganizationRef(o.Id, o.Name, o.OrgNumber, o.Status, o.AccountManagerId))
            .ToListAsync(cancellationToken);

    public async Task ApplyRegistryStatusAsync(Guid organizationId, BrregStatus status, DateTimeOffset checkedAt, CancellationToken cancellationToken)
    {
        var organization = await db.Organizations.SingleOrDefaultAsync(o => o.Id == organizationId, cancellationToken);
        if (organization is null)
        {
            return;
        }

        organization.ApplyRegistryStatus(status, checkedAt);
        await db.SaveChangesAsync(cancellationToken);
    }

    public async Task<IOrganizationMatcher> CreateMatcherAsync(CancellationToken cancellationToken)
    {
        var candidates = await db.Organizations.AsNoTracking()
            .Select(o => new DuplicateCandidate(o.Id, o.Name, o.OrgNumber, o.Email, o.Phone, o.Domains))
            .ToListAsync(cancellationToken);
        return new OrganizationMatcher(candidates);
    }

    public async Task<ImportOrganizationResult> ImportOrganizationAsync(ExternalOrganizationData data, OrganizationStatus status, CancellationToken cancellationToken)
    {
        var orgNumber = OrgNumber.IsValid(data.OrgNumber) ? OrgNumber.Normalize(data.OrgNumber!) : null;
        if (orgNumber is not null &&
            await db.Organizations.AsNoTracking().Where(o => o.OrgNumber == orgNumber).Select(o => (Guid?)o.Id).FirstOrDefaultAsync(cancellationToken) is { } existingId)
        {
            return new ImportOrganizationResult(existingId, Created: false);
        }

        var details = new OrganizationDetails(
            data.Name.Trim(), orgNumber, null, status, null, data.Website, data.Phone, ValidEmail(data.Email), ValidEmail(data.Billing?.InvoiceEmail),
            data.Billing?.EhfEnabled ?? false, null, null, ToAddress(data.PostalAddress), ToAddress(data.VisitAddress), ToAddress(data.Billing?.Address),
            data.Domains);
        var created = Organization.Create(details);
        if (!created.IsSuccess)
        {
            throw new InvalidOperationException($"Cannot import organization: {created.Error!.Code}.");
        }

        db.Organizations.Add(created.Value);
        await SaveOrDiscardAsync(cancellationToken);
        return new ImportOrganizationResult(created.Value.Id, Created: true);
    }

    public async Task<bool> ApplyExternalBillingDetailsAsync(Guid organizationId, BillingData billing, CancellationToken cancellationToken)
    {
        if (BillingDetailsMaster != BillingDetailsMaster.PowerOffice)
        {
            return false;
        }

        var organization = await db.Organizations.SingleOrDefaultAsync(o => o.Id == organizationId, cancellationToken);
        if (organization is null || !organization.ApplyBillingDetails(ValidEmail(billing.InvoiceEmail), billing.EhfEnabled, ToAddress(billing.Address)))
        {
            return false;
        }

        await db.SaveChangesAsync(cancellationToken);
        return true;
    }

    public async Task<OrganizationSyncView?> GetOrganizationForSyncAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        var o = await db.Organizations.AsNoTracking().IgnoreQueryFilters().SingleOrDefaultAsync(x => x.Id == organizationId, cancellationToken);
        return o is null
            ? null
            : new OrganizationSyncView(
                o.Id, o.Name, o.OrgNumber, o.Status, o.Email, o.Phone, o.Website, o.Domains,
                ToData(o.VisitAddress), ToData(o.PostalAddress),
                new BillingData(o.InvoiceEmail, o.EhfEnabled, ToData(o.BillingAddress)),
                o.IsDeleted);
    }

    public async Task<IReadOnlyDictionary<Guid, string>> GetOrganizationNamesAsync(IReadOnlyCollection<Guid> organizationIds, CancellationToken cancellationToken) =>
        await db.Organizations.AsNoTracking()
            .Where(o => organizationIds.Contains(o.Id))
            .ToDictionaryAsync(o => o.Id, o => o.Name, cancellationToken);

    public async Task<IReadOnlyDictionary<string, Guid>> FindOrganizationsByOrgNumberAsync(
        IReadOnlyCollection<string> orgNumbers, CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, Guid>(StringComparer.Ordinal);
        foreach (var batch in orgNumbers.Select(OrgNumber.Normalize).Where(n => n.Length > 0).Distinct(StringComparer.Ordinal).Chunk(1000))
        {
            var rows = await db.Organizations.AsNoTracking()
                .Where(o => o.OrgNumber != null && batch.Contains(o.OrgNumber))
                .OrderBy(o => o.CreatedAt).ThenBy(o => o.Id)
                .Select(o => new { o.Id, OrgNumber = o.OrgNumber! })
                .ToListAsync(cancellationToken);
            foreach (var row in rows)
            {
                // Organization numbers are unique among live organizations (BR-CUS-06); the oldest wins should data ever say otherwise.
                result.TryAdd(row.OrgNumber, row.Id);
            }
        }

        return result;
    }

    public async Task<IReadOnlyDictionary<Guid, string>> GetOrgNumbersAsync(IReadOnlyCollection<Guid> organizationIds, CancellationToken cancellationToken)
    {
        var result = new Dictionary<Guid, string>();
        foreach (var batch in organizationIds.Distinct().Chunk(1000))
        {
            var rows = await db.Organizations.AsNoTracking()
                .Where(o => o.OrgNumber != null && batch.Contains(o.Id))
                .Select(o => new { o.Id, OrgNumber = o.OrgNumber! })
                .ToListAsync(cancellationToken);
            foreach (var row in rows)
            {
                result[row.Id] = row.OrgNumber;
            }
        }

        return result;
    }

    public async Task<IReadOnlyDictionary<Guid, Guid?>> GetAccountManagerIdsAsync(IReadOnlyCollection<Guid> organizationIds, CancellationToken cancellationToken)
    {
        if (organizationIds.Count == 0) return new Dictionary<Guid, Guid?>();
        return await db.Organizations.AsNoTracking()
            .Where(o => organizationIds.Contains(o.Id))
            .ToDictionaryAsync(o => o.Id, o => o.AccountManagerId, cancellationToken);
    }

    public async Task<IReadOnlyList<OrganizationRef>> GetAllOrganizationsAsync(CancellationToken cancellationToken) =>
        await db.Organizations.AsNoTracking()
            .OrderBy(o => o.Name)
            .Select(o => new OrganizationRef(o.Id, o.Name, o.OrgNumber, o.Status, o.AccountManagerId))
            .ToListAsync(cancellationToken);

    public async Task<IReadOnlyDictionary<Guid, Guid>> GetInvoiceTargetsAsync(CancellationToken cancellationToken)
    {
        var children = await db.Organizations.AsNoTracking()
            .Where(o => o.BilledThroughParent && o.ParentId != null)
            .Select(o => new { o.Id, ParentId = o.ParentId!.Value })
            .ToListAsync(cancellationToken);
        var parents = children.ToDictionary(c => c.Id, c => c.ParentId);

        // A subsidiary of a subsidiary follows the chain upwards; the depth limit keeps a broken tree from spinning.
        var targets = new Dictionary<Guid, Guid>();
        foreach (var (child, parent) in parents.Select(p => (p.Key, p.Value)))
        {
            var target = parent;
            for (var step = 0; step < 10 && parents.TryGetValue(target, out var above) && above != child; step++)
            {
                target = above;
            }

            if (target != child)
            {
                targets[child] = target;
            }
        }

        return targets;
    }

    public async Task<IReadOnlyDictionary<string, Guid>> FindContactsByEmailAsync(IReadOnlyCollection<string> emails, CancellationToken cancellationToken)
    {
        var normalized = emails.Select(Contact.NormalizeEmail).Where(e => e is not null).Select(e => e!).Distinct().ToList();
        return await db.Contacts.AsNoTracking()
            .Where(c => c.Email != null && normalized.Contains(c.Email))
            .ToDictionaryAsync(c => c.Email!, c => c.Id, cancellationToken);
    }

    public async Task<ContactSyncView?> GetContactForSyncAsync(Guid contactId, CancellationToken cancellationToken)
    {
        var c = await db.Contacts.AsNoTracking().IgnoreQueryFilters().Include(x => x.Affiliations)
            .SingleOrDefaultAsync(x => x.Id == contactId, cancellationToken);
        return c is null ? null : ToSyncView(c);
    }

    public async Task<IReadOnlyList<ContactSyncView>> GetOrganizationContactsAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        // Every active contact of the organization in one query, primary first (DEV-12: no cut at 50, no query per contact).
        var contacts = await db.Contacts.AsNoTracking().IgnoreQueryFilters().Include(c => c.Affiliations)
            .Where(c => c.Affiliations.Any(a => a.OrganizationId == organizationId && a.IsActive && !a.IsDeleted))
            .ToListAsync(cancellationToken);
        return contacts
            .OrderByDescending(c => c.Affiliations.Any(a => a.OrganizationId == organizationId && a.IsActive && !a.IsDeleted && a.IsPrimary))
            .ThenBy(c => c.Id)
            .Select(ToSyncView)
            .ToList();
    }

    private static ContactSyncView ToSyncView(Contact c) =>
        new(c.Id, c.FirstName, c.LastName, c.Email, c.Phone, c.MobilePhone, c.IsDeleted,
            c.Affiliations.Where(a => !a.IsDeleted)
                .OrderByDescending(a => a.IsPrimary).ThenBy(a => a.CreatedAt)
                .Select(a => new ContactAffiliationView(a.OrganizationId, a.Title, a.Roles.HasFlag(ContactRoles.Billing), a.IsPrimary, a.IsActive))
                .ToList());

    public async Task<IReadOnlyDictionary<Guid, string>> GetContactNamesAsync(IReadOnlyCollection<Guid> contactIds, CancellationToken cancellationToken) =>
        await db.Contacts.AsNoTracking()
            .Where(c => contactIds.Contains(c.Id))
            .ToDictionaryAsync(c => c.Id, c => (c.FirstName + " " + c.LastName).Trim(), cancellationToken);

    public async Task<ImportContactResult> ImportContactAsync(Guid organizationId, ExternalContactData data, CancellationToken cancellationToken)
    {
        var email = Contact.NormalizeEmail(ValidEmail(data.Email));
        var contact = email is null
            ? null
            : await db.Contacts.Include(c => c.Affiliations).SingleOrDefaultAsync(c => c.Email == email, cancellationToken);
        var created = contact is null;
        if (contact is null)
        {
            var result = Contact.Create(new ContactDetails(
                string.IsNullOrWhiteSpace(data.FirstName) && string.IsNullOrWhiteSpace(data.LastName) ? (email ?? "?") : data.FirstName,
                data.LastName, email, data.Phone, data.MobilePhone, null));
            if (!result.IsSuccess)
            {
                throw new InvalidOperationException($"Cannot import contact: {result.Error!.Code}.");
            }

            contact = result.Value;
            db.Contacts.Add(contact);
        }

        if (!contact.Affiliations.Any(a => a.OrganizationId == organizationId && a.IsActive))
        {
            contact.Affiliate(organizationId, new AffiliationDetails(data.Title, ContactRoles.None, IsPrimary: false));
        }

        await SaveOrDiscardAsync(cancellationToken);
        return new ImportContactResult(contact.Id, created);
    }

    /// <summary>
    /// An import record whose save fails (a constraint, say) must not leave its half-built entities in this context, where the
    /// next record's save would trip over them: they are dropped and the failure goes on to the caller, record by record.
    /// </summary>
    private async Task SaveOrDiscardAsync(CancellationToken cancellationToken)
    {
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            db.ChangeTracker.Clear();
            throw;
        }
    }

    private static Address? ToAddress(AddressData? data) =>
        data is null ? null : new Address(data.Street, data.PostalCode, data.City, data.CountryCode is { Length: 2 } c ? c : null);

    private static AddressData ToData(Address address) => new(address.Street, address.PostalCode, address.City, address.CountryCode);

    private static string? ValidEmail(string? email) =>
        email is not null && Crm.SharedKernel.Text.EmailAddresses.IsValid(email.Trim()) ? email.Trim() : null;
}

internal sealed class OrganizationMatcher(IReadOnlyList<DuplicateCandidate> organizations) : IOrganizationMatcher
{
    private readonly Dictionary<string, List<DuplicateCandidate>> _byOrgNumber = organizations
        .Where(o => o.OrgNumber is not null)
        .GroupBy(o => o.OrgNumber!)
        .ToDictionary(g => g.Key, g => g.ToList());

    public IReadOnlyList<OrganizationMatch> Match(ExternalOrganizationData data, int take = 3)
    {
        var orgNumber = OrgNumber.IsValid(data.OrgNumber) ? OrgNumber.Normalize(data.OrgNumber!) : null;
        if (orgNumber is not null && _byOrgNumber.TryGetValue(orgNumber, out var exact))
        {
            return exact.Select(o => new OrganizationMatch(o.Id, o.Name, o.OrgNumber, [MatchReason.OrgNumber])).ToList();
        }

        var external = new DuplicateCandidate(Guid.Empty, data.Name, orgNumber, data.Email, data.Phone,
            data.Domains.Select(d => d.Trim().TrimStart('@').ToLowerInvariant()).ToList());
        return organizations
            // A different org number means a different legal entity.
            .Where(o => orgNumber is null || o.OrgNumber is null)
            .Select(o => (Organization: o, Reasons: DuplicateDetector.Compare(external, o)))
            .Where(x => x.Reasons.Count > 0)
            .OrderByDescending(x => x.Reasons.Count)
            .Take(take)
            .Select(x => new OrganizationMatch(x.Organization.Id, x.Organization.Name, x.Organization.OrgNumber, x.Reasons.Select(ToMatchReason).ToList()))
            .ToList();
    }

    private static MatchReason ToMatchReason(DuplicateReason reason) => reason switch
    {
        DuplicateReason.SameName => MatchReason.SameName,
        DuplicateReason.SharedDomain => MatchReason.SharedDomain,
        DuplicateReason.SameEmailDomain => MatchReason.SameEmailDomain,
        _ => MatchReason.SamePhone,
    };
}
