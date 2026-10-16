using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.Privacy.Contracts;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Privacy;

internal static class CustomersPrivacy
{
    public const string Module = CustomersDbContext.SchemaName;
    public const string ContactClass = "customers.contact";
    public const string AffiliationClass = "customers.affiliation";

    public static RecordRef ContactRecord(Guid id) => new(Module, nameof(Contact), id);

    public static RecordRef AffiliationRecord(Guid id) => new(Module, nameof(OrganizationContact), id);

    /// <summary>A contact with every affiliation, erased or not (privacy work must see what lists hide).</summary>
    public static Task<Contact?> LoadAsync(CustomersDbContext db, Guid id, CancellationToken ct) =>
        db.Contacts.IgnoreQueryFilters().Include(c => c.Affiliations).SingleOrDefaultAsync(c => c.Id == id, ct);
}

/// <summary>Who a contact person is, for a privacy case (DEV-11): the record, its addresses and numbers, its affiliations.</summary>
internal sealed class ContactSubjectResolver(CustomersDbContext db) : IDataSubjectResolver
{
    public DataSubjectKind Kind => DataSubjectKind.Contact;

    public async Task<DataSubject?> ResolveAsync(Guid id, CancellationToken cancellationToken)
    {
        if (await CustomersPrivacy.LoadAsync(db, id, cancellationToken) is not { } contact)
        {
            return null;
        }

        return new DataSubject(
            DataSubjectKind.Contact,
            contact.Id,
            CustomersPrivacy.ContactRecord(contact.Id),
            contact.Email is { } email ? [email] : [],
            new[] { contact.Phone, contact.MobilePhone }.OfType<string>().ToList(),
            [],
            contact.Affiliations.Select(a => CustomersPrivacy.AffiliationRecord(a.Id)).ToList());
    }
}

/// <summary>
/// The customers module's part in subject requests (DEV-11): the contact person and their affiliations. Erasure keeps the
/// person's row under a pseudonym (deals, quotes, activities and tickets refer to it) and ends every affiliation.
/// </summary>
internal sealed class CustomersPersonalData(CustomersDbContext db) : IPersonalDataContributor
{
    public string Module => CustomersPrivacy.Module;

    public async Task<PersonalDataSection> ExportAsync(DataSubject subject, CancellationToken cancellationToken)
    {
        if (subject.Kind != DataSubjectKind.Contact)
        {
            return new PersonalDataSection(Module, [], ["A lead is not a contact: a contact with the same e-mail address is a separate record with its own request."]);
        }

        if (await CustomersPrivacy.LoadAsync(db, subject.Id, cancellationToken) is not { } contact)
        {
            return new PersonalDataSection(Module, [], []);
        }

        var organizationIds = contact.Affiliations.Select(a => a.OrganizationId).ToList();
        var organizations = await db.Organizations.IgnoreQueryFilters().AsNoTracking()
            .Where(o => organizationIds.Contains(o.Id)).ToDictionaryAsync(o => o.Id, o => o.Name, cancellationToken);
        var items = new List<PersonalDataItem>
        {
            new("contact", contact.Id, new Dictionary<string, string?>
            {
                ["firstName"] = contact.FirstName,
                ["lastName"] = contact.LastName,
                ["email"] = contact.Email,
                ["phone"] = contact.Phone,
                ["mobilePhone"] = contact.MobilePhone,
                ["preferredLanguage"] = contact.PreferredLanguage,
                ["createdAt"] = Format(contact.CreatedAt),
                ["modifiedAt"] = contact.ModifiedAt is { } modified ? Format(modified) : null,
            }),
        };
        items.AddRange(contact.Affiliations.Select(a => new PersonalDataItem("affiliation", a.Id, new Dictionary<string, string?>
        {
            ["organization"] = organizations.GetValueOrDefault(a.OrganizationId),
            ["title"] = a.Title,
            ["roles"] = a.Roles.ToString(),
            ["primary"] = a.IsPrimary ? "true" : "false",
            ["active"] = a.IsActive ? "true" : "false",
        })));
        return new PersonalDataSection(Module, items, []);
    }

    public async Task<IReadOnlyList<PlannedErasure>> PlanAsync(DataSubject subject, CancellationToken cancellationToken)
    {
        if (subject.Kind != DataSubjectKind.Contact || await CustomersPrivacy.LoadAsync(db, subject.Id, cancellationToken) is not { } contact)
        {
            return [];
        }

        var plan = new List<PlannedErasure> { new(CustomersPrivacy.ContactRecord(contact.Id), ErasureAction.Pseudonymize, CustomersPrivacy.ContactClass) };
        plan.AddRange(contact.Affiliations.Select(a =>
            new PlannedErasure(CustomersPrivacy.AffiliationRecord(a.Id), ErasureAction.Delete, CustomersPrivacy.AffiliationClass)));
        return plan;
    }

    public async Task<IReadOnlyList<ErasedRecord>> EraseAsync(
        DataSubject subject, IReadOnlyList<PlannedErasure> plan, string reference, CancellationToken cancellationToken)
    {
        var erased = new List<ErasedRecord>();
        foreach (var item in plan.Where(p => p.Action != ErasureAction.Retain && p.Record.EntityType == nameof(Contact)))
        {
            if (await CustomersPrivacy.LoadAsync(db, item.Record.EntityId, cancellationToken) is not { } contact)
            {
                continue;
            }

            // A held affiliation stays as it is; the person and the other affiliations are erased.
            var held = plan.Where(p => p.Action == ErasureAction.Retain && p.Record.EntityType == nameof(OrganizationContact))
                .Select(p => p.Record.EntityId).ToHashSet();
            contact.Pseudonymize(reference, held);
            erased.Add(new ErasedRecord(item.Record, item.Action, item.DataClass));
            erased.AddRange(contact.Affiliations.Where(a => !held.Contains(a.Id))
                .Select(a => new ErasedRecord(CustomersPrivacy.AffiliationRecord(a.Id), ErasureAction.Delete, CustomersPrivacy.AffiliationClass)));
        }

        await db.SaveChangesAsync(cancellationToken);
        return erased;
    }

    public async Task<int> ReapplyAsync(IReadOnlyList<ErasedRecord> records, string reference, CancellationToken cancellationToken)
    {
        var applied = 0;
        var erasedAffiliations = records.Where(r => r.Record.EntityType == nameof(OrganizationContact)).Select(r => r.Record.EntityId).ToHashSet();
        foreach (var record in records.Where(r => r.Record.EntityType == nameof(Contact)))
        {
            // Affiliations the erasure did not cover (a legal hold kept them) stay as the restored copy has them.
            if (await CustomersPrivacy.LoadAsync(db, record.Record.EntityId, cancellationToken) is { } contact &&
                contact.Pseudonymize(reference, contact.Affiliations.Select(a => a.Id).Where(id => !erasedAffiliations.Contains(id)).ToHashSet()))
            {
                applied++;
            }
        }

        await db.SaveChangesAsync(cancellationToken);
        return applied;
    }

    private static string Format(DateTimeOffset value) => value.ToString("O", CultureInfo.InvariantCulture);
}

/// <summary>
/// Contacts of former customers (docs/04 §8, SEC-GDPR-05): a person whose every organization is Former and who has not been
/// touched for the approved period is erased the same way a privacy case erases them. "Untouched" is the contact's and
/// its organizations' last change — the CRM records no other end date of a relationship.
/// </summary>
internal sealed class FormerContactsRetention(CustomersDbContext db) : IRetentionContributor
{
    public const string Class = "customers.former-contacts";

    public string DataClass => Class;

    public Task<int> CountAsync(DateTimeOffset olderThan, CancellationToken cancellationToken) => Due(olderThan).CountAsync(cancellationToken);

    public async Task<int> ApplyAsync(DateTimeOffset olderThan, int batchSize, CancellationToken cancellationToken)
    {
        var ids = await Due(olderThan).OrderBy(c => c.Id).Select(c => c.Id).Take(batchSize).ToListAsync(cancellationToken);
        foreach (var id in ids)
        {
            (await CustomersPrivacy.LoadAsync(db, id, cancellationToken))?.Pseudonymize($"retention:{Class}");
        }

        await db.SaveChangesAsync(cancellationToken);
        return ids.Count;
    }

    private IQueryable<Contact> Due(DateTimeOffset olderThan) =>
        db.Contacts.Where(c =>
            (c.ModifiedAt ?? c.CreatedAt) < olderThan &&
            c.Affiliations.Any() &&
            c.Affiliations.All(a => db.Organizations.IgnoreQueryFilters().Any(o =>
                o.Id == a.OrganizationId && o.Status == OrganizationStatus.Former && (o.ModifiedAt ?? o.CreatedAt) < olderThan)));
}
