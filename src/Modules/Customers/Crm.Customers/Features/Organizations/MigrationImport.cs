using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.Privacy.Contracts;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Crm.SharedKernel.Text;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Organizations;

/// <summary>One row of the migration preview: what the file says and what the CRM would do with it.</summary>
public sealed record MigrationRow(int Line, string Name, string? OrgNumber, string Action, string? Detail, Guid? OrganizationId);

public sealed record MigrationResult(
    int Created,
    int Updated,
    int Unchanged,
    int Contacts,
    int Conflicts,
    int Failed,
    IReadOnlyList<MigrationRow> Rows,
    IReadOnlyList<string> Warnings);

/// <summary>
/// Data migration from the old systems (ТЗ §6.6): organizations and their main contact from one file. Matching follows
/// BR-CUS-06 — organization number first, then a shared domain, then the exact name; anything ambiguous is reported for a
/// person to decide instead of being merged silently. <c>?dryRun=true</c> counts exactly what the real run would write.
/// </summary>
internal sealed class MigrationImportService(
    CustomersDbContext db,
    ICurrentUser currentUser,
    IRequestContext requestContext,
    TimeProvider time,
    ISuppressionList suppressions)
{
    /// <summary>A migration file is a one-off job, not a sync: a few thousand rows at a time keeps the report readable.</summary>
    private const int MaxRows = 5000;

    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["name"] = "name",
        ["navn"] = "name",
        ["kunde"] = "name",
        ["kundenavn"] = "name",
        ["customer"] = "name",
        ["organizationname"] = "name",
        ["orgnumber"] = "orgnumber",
        ["orgnr"] = "orgnumber",
        ["organisasjonsnummer"] = "orgnumber",
        ["organizationnumber"] = "orgnumber",
        ["status"] = "status",
        ["email"] = "email",
        ["epost"] = "email",
        ["e-post"] = "email",
        ["phone"] = "phone",
        ["telefon"] = "phone",
        ["website"] = "website",
        ["nettside"] = "website",
        ["hjemmeside"] = "website",
        ["domain"] = "domain",
        ["domene"] = "domain",
        ["invoiceemail"] = "invoiceemail",
        ["fakturaepost"] = "invoiceemail",
        ["ehf"] = "ehf",
        ["street"] = "street",
        ["adresse"] = "street",
        ["gateadresse"] = "street",
        ["postalcode"] = "postalcode",
        ["postnummer"] = "postalcode",
        ["city"] = "city",
        ["poststed"] = "city",
        ["contactfirstname"] = "contactfirstname",
        ["fornavn"] = "contactfirstname",
        ["contactlastname"] = "contactlastname",
        ["etternavn"] = "contactlastname",
        ["contactemail"] = "contactemail",
        ["kontaktepost"] = "contactemail",
        ["contactphone"] = "contactphone",
        ["kontakttelefon"] = "contactphone",
        ["contactrole"] = "contactrole",
        ["kontaktrolle"] = "contactrole",
        ["contacttitle"] = "contacttitle",
        ["stilling"] = "contacttitle",
    };

    public async Task<Result<MigrationResult>> ImportAsync(string csv, bool dryRun, CancellationToken ct)
    {
        var table = CsvTable.Parse(csv, Aliases);
        if (table is null || !table.Has("name"))
        {
            return Error.Validation("CUS_MIGRATION_INVALID", "The file needs a header row with at least a name column.");
        }

        if (table.RowCount > MaxRows)
        {
            return Error.Validation("CUS_MIGRATION_TOO_LARGE", $"Split the file: at most {MaxRows} rows at a time.");
        }

        var rows = new List<MigrationRow>();
        var warnings = table.UnknownColumns.Select(c => $"Column '{c}' was ignored.").Take(10).ToList();
        int created = 0, updated = 0, unchanged = 0, contacts = 0, conflicts = 0, failed = 0;
        // DEV-11: people erased at their request do not come back with an old system's file.
        var suppressed = await suppressions.SnapshotAsync(ct);

        for (var row = 0; row < table.RowCount; row++)
        {
            var line = CsvTable.LineNumber(row);
            var name = table.Value(row, "name");
            if (name is null)
            {
                failed++;
                rows.Add(new MigrationRow(line, "—", null, "Failed", "The name is missing.", null));
                continue;
            }

            var orgNumber = OrgNumber.IsValid(table.Value(row, "orgnumber")) ? OrgNumber.Normalize(table.Value(row, "orgnumber")!) : null;
            if (table.Value(row, "orgnumber") is { Length: > 0 } rawNumber && orgNumber is null)
            {
                warnings.Add($"Row {line}: '{rawNumber}' is not a valid organization number and was left out.");
            }

            var match = await FindAsync(name, orgNumber, table.Value(row, "domain"), ct);
            if (match.Ambiguous)
            {
                conflicts++;
                rows.Add(new MigrationRow(line, name, orgNumber, "Conflict", match.Detail, null));
                continue;
            }

            var details = Details(table, row, name, orgNumber);
            if (match.Organization is { } existing)
            {
                var before = Snapshot(existing);
                existing.Update(details with
                {
                    // The file never clears what the CRM already knows; it only fills the gaps.
                    OrgNumber = details.OrgNumber ?? existing.OrgNumber,
                    Email = details.Email ?? existing.Email,
                    Phone = details.Phone ?? existing.Phone,
                    Website = details.Website ?? existing.Website,
                    Status = existing.Status,
                });
                var changed = Snapshot(existing) != before;
                if (changed)
                {
                    updated++;
                }
                else
                {
                    unchanged++;
                }

                rows.Add(new MigrationRow(line, name, orgNumber, changed ? "Updated" : "Unchanged", match.Detail, existing.Id));
                contacts += await UpsertContactAsync(table, row, line, existing.Id, suppressed, warnings, ct) ? 1 : 0;
                continue;
            }

            var createdOrganization = Organization.Create(details);
            if (!createdOrganization.IsSuccess)
            {
                failed++;
                rows.Add(new MigrationRow(line, name, orgNumber, "Failed", createdOrganization.Error!.Message, null));
                continue;
            }

            db.Organizations.Add(createdOrganization.Value);
            created++;
            rows.Add(new MigrationRow(line, name, orgNumber, "Created", null, createdOrganization.Value.Id));
            contacts += await UpsertContactAsync(table, row, line, createdOrganization.Value.Id, suppressed, warnings, ct) ? 1 : 0;
        }

        if (dryRun)
        {
            // Nothing is written: the tracked changes are dropped, so the preview counts exactly what the real run would do.
            db.ChangeTracker.Clear();
        }
        else
        {
            db.RecordAudit(currentUser, requestContext, time, "Import", "Organization", Guid.Empty, new
            {
                Source = "Migration",
                Rows = table.RowCount,
                Created = created,
                Updated = updated,
                Conflicts = conflicts,
            });
            await db.SaveChangesAsync(ct);
        }

        return new MigrationResult(
            created,
            updated,
            unchanged,
            contacts,
            conflicts,
            failed,
            rows.Where(r => r.Action != "Unchanged").Take(200).ToList(),
            warnings.Take(20).ToList());
    }

    private sealed record Match(Organization? Organization, bool Ambiguous, string? Detail);

    /// <summary>BR-CUS-06 order: organization number, then a shared domain, then the exact name.</summary>
    private async Task<Match> FindAsync(string name, string? orgNumber, string? domain, CancellationToken ct)
    {
        if (orgNumber is not null)
        {
            var byNumber = await db.Organizations.SingleOrDefaultAsync(o => o.OrgNumber == orgNumber, ct);
            if (byNumber is not null)
            {
                return new Match(byNumber, false, "Matched on the organization number.");
            }
        }

        var cleanDomain = domain?.Trim().ToLowerInvariant().Replace("https://", string.Empty, StringComparison.Ordinal)
            .Replace("http://", string.Empty, StringComparison.Ordinal).TrimEnd('/');
        if (!string.IsNullOrEmpty(cleanDomain))
        {
            var byDomain = await db.Organizations.Where(o => o.Domains.Contains(cleanDomain)).Take(2).ToListAsync(ct);
            if (byDomain.Count == 1)
            {
                return new Match(byDomain[0], false, $"Matched on the domain {cleanDomain}.");
            }

            if (byDomain.Count > 1)
            {
                return new Match(null, true, $"Several organizations share the domain {cleanDomain}.");
            }
        }

        var trimmed = name.Trim();
        var byName = await db.Organizations.Where(o => o.Name == trimmed).Take(2).ToListAsync(ct);
        return byName.Count switch
        {
            1 => new Match(byName[0], false, "Matched on the name."),
            > 1 => new Match(null, true, $"Several organizations are called «{trimmed}»."),
            _ => new Match(null, false, null),
        };
    }

    private static OrganizationDetails Details(CsvTable table, int row, string name, string? orgNumber)
    {
        var status = table.Value(row, "status") switch
        {
            { } text when Enum.TryParse<OrganizationStatus>(text, ignoreCase: true, out var parsed) => parsed,
            _ => OrganizationStatus.Customer,
        };
        var address = new Address(table.Value(row, "street"), table.Value(row, "postalcode"), table.Value(row, "city"), "NO");
        var domain = table.Value(row, "domain");

        return new OrganizationDetails(
            name,
            orgNumber,
            null,
            status,
            null,
            table.Value(row, "website"),
            table.Value(row, "phone"),
            table.Value(row, "email"),
            table.Value(row, "invoiceemail"),
            table.Value(row, "ehf")?.ToLowerInvariant() is "true" or "ja" or "1",
            null,
            null,
            address,
            address,
            address,
            domain is null ? [] : [domain.Trim().ToLowerInvariant()]);
    }

    /// <summary>Creates or affiliates the row's contact person; returns true when something was written.</summary>
    private async Task<bool> UpsertContactAsync(
        CsvTable table, int row, int line, Guid organizationId, ISuppressionCheck suppressed, List<string> warnings, CancellationToken ct)
    {
        var first = table.Value(row, "contactfirstname");
        var last = table.Value(row, "contactlastname");
        var email = table.Value(row, "contactemail");
        if (first is null && last is null && email is null)
        {
            return false;
        }

        if (suppressed.IsSuppressed(email, null))
        {
            warnings.Add($"Row {line}: the contact person was erased at their request and is not imported again (DEV-11).");
            return false;
        }

        var details = new ContactDetails(first ?? "—", last ?? "—", email, table.Value(row, "contactphone"), null, null);
        var normalizedEmail = Contact.NormalizeEmail(email);
        var contact = normalizedEmail is null
            ? null
            : await db.Contacts.Include(c => c.Affiliations).FirstOrDefaultAsync(c => c.Email == normalizedEmail, ct);

        if (contact is null)
        {
            var created = Contact.Create(details);
            if (!created.IsSuccess)
            {
                return false;
            }

            contact = created.Value;
            db.Contacts.Add(contact);
        }
        else
        {
            contact.Update(details);
        }

        var roles = table.Value(row, "contactrole")?.ToLowerInvariant() switch
        {
            "decisionmaker" or "beslutningstaker" or "lpr" => ContactRoles.DecisionMaker,
            "technical" or "teknisk" => ContactRoles.Technical,
            "billing" or "faktura" => ContactRoles.Billing,
            _ => ContactRoles.EndUser,
        };
        contact.Affiliate(organizationId, new AffiliationDetails(table.Value(row, "contacttitle"), roles, IsPrimary: true));
        return true;
    }

    private static string Snapshot(Organization organization) =>
        string.Join('|', organization.Name, organization.OrgNumber, organization.Email, organization.Phone, organization.Website,
            organization.InvoiceEmail, string.Join(',', organization.Domains), organization.PostalAddress.Street, organization.PostalAddress.City);
}
